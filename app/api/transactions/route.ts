import type { Hex } from 'viem'
import { NextResponse } from 'next/server'
import { formatEther, formatUnits, zeroAddress } from 'viem'
import { BN_DEX_ROUTER_ADDRESS, USDT_ADDRESS } from '@/constants'
import alphaTokens from '@/constants/tokens'
import { getTransactions } from '@/lib/nodereal-api'
import { getSwapInfo, isAddressEqual, isValidSourceToken, retry } from '@/lib/utils'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const address = searchParams.get('address') as Hex
  const startblock = Number(searchParams.get('startblock') || '0')
  const endblock = Number(searchParams.get('endblock') || '99999999')

  if (!address) {
    return NextResponse.json({ error: 'Address is required' }, { status: 400 })
  }

  let [rawNormalTransactions = [], rawInternalTransactions = [], rawTokenTransactions = []] = await Promise.all([
    retry(
      getTransactions,
      3,
    )({
      action: 'txlist',
      address,
      startblock,
      endblock,
    }),
    retry(
      getTransactions,
      3,
    )({
      action: 'txlistinternal',
      address,
      startblock,
      endblock,
    }),
    retry(
      getTransactions,
      3,
    )({
      action: 'tokentx',
      address,
      startblock,
      endblock,
    }),
  ])

  if (!rawNormalTransactions?.length && !rawTokenTransactions?.length) {
    console.log('No transactions found for address:', address)
    return NextResponse.json([])
  }

  const isBinanceDexTx = (from: Hex, to: Hex) =>
    isAddressEqual(from, address) && isAddressEqual(to, BN_DEX_ROUTER_ADDRESS)

  const isAlphaTokenTx = (contractAddress: Hex) =>
    alphaTokens.some(token => isAddressEqual(token.contractAddress, contractAddress))

  while (
    !rawNormalTransactions?.some(tx => isBinanceDexTx(tx.from, tx.to))
    && rawTokenTransactions?.some(tx => isAlphaTokenTx(tx.contractAddress))
  ) {
    console.log('No normal transactions found, retrying with txlist...')
    rawNormalTransactions = await getTransactions({
      action: 'txlist',
      address,
      startblock,
      endblock,
    })
  }

  while (rawNormalTransactions?.some(tx => isBinanceDexTx(tx.from, tx.to)) && !rawTokenTransactions?.length) {
    console.log('No token transactions found, retrying with tokentx...')
    rawTokenTransactions = await getTransactions({
      action: 'tokentx',
      address,
      startblock,
      endblock,
    })
  }

  const normalTransactions = rawNormalTransactions.filter(tx => isBinanceDexTx(tx.from, tx.to))

  const tokenTransactions = rawTokenTransactions.filter(tx => BigInt(tx.value) === 0n || BigInt(tx.value) > 1n)

  const transactions: {
    hash: string
    timestamp: number
    status: 'success' | 'failed'
    gas: number
    from?: {
      address: Hex
      symbol: string
      decimals: number
      amount: number
    }
    to?: {
      address: Hex
      symbol: string
      decimals: number
      amount: number
    }
  }[] = []

  for (const tx of normalTransactions) {
    const status = tx.isError === '0' && tx.txreceipt_status === '1' ? 'success' : 'failed'

    let from, to
    if (status === 'failed') {
      ;({ from, to } = await retry(getSwapInfo, 3)(tx))
    }

    transactions.push({
      hash: tx.hash,
      timestamp: Number(tx.timeStamp),
      status,
      gas: Number(formatEther(BigInt(tx.gasUsed) * BigInt(tx.gasPrice))),
      from:
        Number(tx.value) > 0
          ? {
              address: zeroAddress,
              symbol: 'BNB',
              decimals: 18,
              amount: Number(formatEther(BigInt(tx.value))),
            }
          : from,
      to,
    })
  }

  for (const tx of rawInternalTransactions) {
    const transaction = transactions.find(t => t.hash === tx.hash)
    if (transaction) {
      if (isAddressEqual(tx.from, address)) {
        transaction.from = {
          address: zeroAddress,
          symbol: 'BNB',
          decimals: 18,
          amount: Number(formatEther(BigInt(tx.value))),
        }
      }
      if (isAddressEqual(tx.to, address)) {
        transaction.to = {
          address: zeroAddress,
          symbol: 'BNB',
          decimals: 18,
          amount: Number(formatEther(BigInt(tx.value))),
        }
      }
    }
  }

  for (const tx of tokenTransactions) {
    const transaction = transactions.find(t => t.hash === tx.hash)
    if (transaction) {
      if (isAddressEqual(tx.from, address)) {
        transaction.from = {
          address: tx.contractAddress,
          symbol: isAddressEqual(tx.contractAddress, USDT_ADDRESS) ? 'USDT' : tx.tokenSymbol,
          decimals: Number(tx.tokenDecimal),
          amount: Number(formatUnits(BigInt(tx.value), Number(tx.tokenDecimal))),
        }
      }
      if (isAddressEqual(tx.to, address)) {
        transaction.to = {
          address: tx.contractAddress,
          symbol: isAddressEqual(tx.contractAddress, USDT_ADDRESS) ? 'USDT' : tx.tokenSymbol,
          decimals: Number(tx.tokenDecimal),
          amount: Number(formatUnits(BigInt(tx.value), Number(tx.tokenDecimal))),
        }
      }
    }
  }

  const resolvedTransactions = transactions
    .filter(tx =>
      alphaTokens.some(
        token =>
          tx.status === 'failed'
          || (isAddressEqual(token.contractAddress, tx.from?.address || '' as Hex) && isValidSourceToken(tx.to?.address || '' as Hex))
          || (isAddressEqual(token.contractAddress, tx.to?.address || '' as Hex) && isValidSourceToken(tx.from?.address || '' as Hex)),
      ),
    )
    .sort((a, b) => b.timestamp - a.timestamp)

  return NextResponse.json(resolvedTransactions)
}
