import type { Hex } from 'viem'
import type { TransactionActionMap } from '@/types'
import process from 'node:process'
import axios from 'axios'
import { zeroAddress } from 'viem'

const NODEREAL_API_KEY = process.env.NODEREAL_API_KEY ?? ''

// NodeReal nr_getAssetTransfers 响应类型
interface NodeRealTransfer {
  category: 'external' | 'internal' | '20' | '721' | '1155'
  blockNum: string // hex string, e.g. "0x6c92dd"
  from: Hex
  to: Hex
  value: string // hex string
  asset: string | null
  hash: Hex
  blockTimeStamp: number
  gasPrice?: number
  gasUsed?: number
  receiptsStatus?: number
  contractAddress?: Hex | null
  decimal?: string | null
  erc721TokenId?: string
  erc1155Metadata?: Array<{ tokenId: string, value: string }>
}

interface NodeRealRpcResponse {
  jsonrpc: string
  id: number
  result?: {
    transfers: NodeRealTransfer[]
    pageKey?: string
  }
  error?: {
    code: number
    message: string
  }
}

const client = axios.create({
  baseURL: `https://bsc-mainnet.nodereal.io/v1/${NODEREAL_API_KEY}`,
  headers: { 'Content-Type': 'application/json' },
})

// nr_getAssetTransfers 最大区块范围: 100,000
const ASSET_TRANSFERS_MAX_RANGE = 100_000

// 并发请求数限制
const CONCURRENCY_LIMIT = 10

/**
 * 获取 BSC 最新区块号
 */
async function getLatestBlockNumber(): Promise<number> {
  const res = await client.post<{ jsonrpc: string, id: number, result: string }>('', {
    jsonrpc: '2.0',
    method: 'eth_blockNumber',
    params: [],
    id: 1,
  })
  return Number.parseInt(res.data.result, 16)
}

/**
 * 将 hex 字符串转换为十进制字符串（兼容大数值）
 */
function parseHexValue(hex: string): string {
  try {
    return BigInt(hex).toString()
  }
  catch {
    return '0'
  }
}

/**
 * NodeReal transfer → Etherscan NormalTransaction 格式
 */
function toNormalTransaction(tx: NodeRealTransfer): TransactionActionMap['txlist'] {
  return {
    blockNumber: Number.parseInt(tx.blockNum, 16).toString(),
    blockHash: '0x' as Hex,
    timeStamp: tx.blockTimeStamp.toString(),
    hash: tx.hash,
    nonce: '0',
    transactionIndex: '0',
    from: tx.from,
    to: tx.to,
    value: parseHexValue(tx.value),
    gas: tx.gasUsed?.toString() || '0',
    gasPrice: tx.gasPrice?.toString() || '0',
    input: '0x' as Hex,
    methodId: '0x' as Hex,
    functionName: '',
    contractAddress: '',
    cumulativeGasUsed: '0',
    txreceipt_status: tx.receiptsStatus?.toString() ?? '1',
    gasUsed: tx.gasUsed?.toString() || '0',
    confirmations: '0',
    isError: tx.receiptsStatus === 0 ? '1' : '0',
  }
}

/**
 * NodeReal transfer → Etherscan InternalTransaction 格式
 */
function toInternalTransaction(tx: NodeRealTransfer): TransactionActionMap['txlistinternal'] {
  return {
    blockNumber: Number.parseInt(tx.blockNum, 16).toString(),
    timeStamp: tx.blockTimeStamp.toString(),
    hash: tx.hash,
    from: tx.from,
    to: tx.to,
    value: parseHexValue(tx.value),
    contractAddress: (tx.contractAddress || zeroAddress) as Hex,
    input: '0x' as Hex,
    type: 'call',
    gas: '0',
    gasUsed: tx.gasUsed?.toString() || '0',
    traceId: '0',
    isError: tx.receiptsStatus === 0 ? '1' : '0',
    errCode: '',
  }
}

/**
 * NodeReal transfer → Etherscan TokenTransaction 格式
 */
function toTokenTransaction(tx: NodeRealTransfer): TransactionActionMap['tokentx'] {
  return {
    blockNumber: Number.parseInt(tx.blockNum, 16).toString(),
    timeStamp: tx.blockTimeStamp.toString(),
    hash: tx.hash,
    nonce: '0',
    blockHash: '0x' as Hex,
    from: tx.from,
    contractAddress: (tx.contractAddress || zeroAddress) as Hex,
    to: tx.to,
    value: parseHexValue(tx.value),
    tokenName: tx.asset || '',
    tokenSymbol: tx.asset || '',
    tokenDecimal: tx.decimal || '18',
    transactionIndex: '0',
    gas: '0',
    gasPrice: '0',
    gasUsed: tx.gasUsed?.toString() || '0',
    cumulativeGasUsed: '0',
    input: '0x' as Hex,
    methodId: '0x' as Hex,
    functionName: '',
    confirmations: '0',
  }
}

/**
 * 调用 nr_getAssetTransfers 获取单个区块范围内的所有 transfers（自动分页）
 * 用于 txlistinternal 和 tokentx
 */
async function fetchAssetTransfers(params: {
  category: string[]
  fromBlock: number
  toBlock: number
  fromAddress?: Hex
  toAddress?: Hex
}): Promise<NodeRealTransfer[]> {
  const allTransfers: NodeRealTransfer[] = []
  let pageKey: string | undefined

  if (params.fromBlock >= params.toBlock) {
    return []
  }

  do {
    const requestParams: Record<string, unknown> = {
      category: params.category,
      fromBlock: `0x${params.fromBlock.toString(16)}`,
      toBlock: `0x${params.toBlock.toString(16)}`,
      order: 'desc',
      excludeZeroValue: false,
      maxCount: '0x3E8',
    }
    if (params.fromAddress)
      requestParams.fromAddress = params.fromAddress
    if (params.toAddress)
      requestParams.toAddress = params.toAddress
    if (pageKey)
      requestParams.pageKey = pageKey

    const res = await client.post<NodeRealRpcResponse>('', {
      jsonrpc: '2.0',
      method: 'nr_getAssetTransfers',
      params: [requestParams],
      id: 1,
    })

    if (res.data.result?.transfers) {
      allTransfers.push(...res.data.result.transfers)
    }

    pageKey = res.data.result?.pageKey
  } while (pageKey)

  return allTransfers
}

/**
 * 通过 eth_getTransactionByHash + eth_getTransactionReceipt 获取交易级别的详细信息
 * 用于补全从 ERC-20 token transfer 发现的交易
 */
async function fetchTransactionByHash(hash: Hex): Promise<{
  from: Hex
  to: Hex
  value: string
  gasPrice: string
  gasUsed: string
  status: string
} | null> {
  try {
    const [txRes, receiptRes] = await Promise.all([
      client.post<{
        jsonrpc: string
        id: number
        result: {
          from: Hex
          to: Hex
          value: string
          gasPrice: string
        } | null
      }>('', {
        jsonrpc: '2.0',
        method: 'eth_getTransactionByHash',
        params: [hash],
        id: 1,
      }),
      client.post<{
        jsonrpc: string
        id: number
        result: {
          gasUsed: string
          status: string
        } | null
      }>('', {
        jsonrpc: '2.0',
        method: 'eth_getTransactionReceipt',
        params: [hash],
        id: 2,
      }),
    ])

    const tx = txRes.data.result
    const receipt = receiptRes.data.result

    if (!tx)
      return null

    return {
      from: tx.from,
      to: tx.to,
      value: tx.value,
      gasPrice: tx.gasPrice,
      gasUsed: receipt?.gasUsed || '0x0',
      status: receipt?.status || '0x1',
    }
  }
  catch (err) {
    console.error('fetchTransactionByHash error:', hash, err)
    return null
  }
}

/**
 * 限流并发执行 Promise
 */
async function parallelLimit<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = []
  let index = 0

  async function worker() {
    while (index < tasks.length) {
      const currentIndex = index++
      results[currentIndex] = await tasks[currentIndex]()
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()))
  return results
}

/**
 * 通过 nr_getAssetTransfers 获取某地址的普通交易（模拟 Etherscan txlist）
 *
 * Etherscan txlist 返回所有 normal transactions，包括发起 ERC-20 事件的 DEX 调用。
 * 但 NodeReal 的 external category 排除了有 ERC-20 事件的交易。
 *
 * 策略：
 * 1. 用 external category 获取纯粹的 native 交易（无 ERC-20 事件）
 * 2. 用 20 category 获取涉及 ERC-20 的交易 hash
 * 3. 对于只在 20 中出现的 hash，调用 eth_getTransactionByHash 获取交易级别的 from/to
 * 4. 合并后按 hash 去重
 */
async function fetchNormalTransactionsByAddress(opts: {
  address: Hex
  startblock: number
  endblock: number
}): Promise<NodeRealTransfer[]> {
  const { address, startblock, endblock } = opts

  // 同时获取 external 和 20 category 的交易
  const [externalTransfers, tokenTransfers] = await Promise.all([
    fetchAssetTransfersByAddress({
      category: ['external'],
      address,
      startblock,
      endblock,
    }),
    fetchAssetTransfersByAddress({
      category: ['20'],
      address,
      startblock,
      endblock,
    }),
  ])

  // 从 external 构建 hash → transfer 映射
  const txMap = new Map<string, NodeRealTransfer>()
  for (const tx of externalTransfers) {
    txMap.set(tx.hash, tx)
  }

  // 收集只在 20 中出现的 unique hashes（这些是 DEX swap 等合约调用）
  const missingHashes = new Set<string>()
  // 同时保存 token transfer 的元数据（gasPrice, gasUsed, blockNum, blockTimeStamp, receiptsStatus）
  const tokenTransferMeta = new Map<string, NodeRealTransfer>()

  for (const tx of tokenTransfers) {
    if (!txMap.has(tx.hash) && !missingHashes.has(tx.hash)) {
      missingHashes.add(tx.hash)
      tokenTransferMeta.set(tx.hash, tx)
    }
  }

  // 对于 missing hashes，调用 eth_getTransactionByHash 获取真实的 from/to
  if (missingHashes.size > 0) {
    const tasks = Array.from(missingHashes).map(hash => () => fetchTransactionByHash(hash as Hex))
    const txDetails = await parallelLimit(tasks, CONCURRENCY_LIMIT)

    // tasks 和 missingHashes 是同序的，直接 zip
    const hashArray = Array.from(missingHashes)
    for (let i = 0; i < hashArray.length; i++) {
      const hash = hashArray[i]
      const detail = txDetails[i]
      const meta = tokenTransferMeta.get(hash)

      if (detail && meta) {
        txMap.set(hash, {
          category: 'external',
          blockNum: meta.blockNum,
          from: detail.from,
          to: detail.to,
          value: detail.value || '0x0',
          asset: null,
          hash: meta.hash,
          blockTimeStamp: meta.blockTimeStamp,
          gasPrice: Number.parseInt(detail.gasPrice || '0', 16),
          gasUsed: Number.parseInt(detail.gasUsed || '0', 16),
          receiptsStatus: detail.status === '0x1' ? 1 : 0,
          contractAddress: null,
        })
      }
    }
  }

  return Array.from(txMap.values())
}

/**
 * 通过 nr_getAssetTransfers 获取某地址的 internal / token 交易
 * 区块范围上限 100,000，双向查询 + 去重
 */
async function fetchAssetTransfersByAddress(opts: {
  category: string[]
  address: Hex
  startblock: number
  endblock: number
}): Promise<NodeRealTransfer[]> {
  const { category, address, startblock, endblock } = opts
  const allTransfers: NodeRealTransfer[] = []

  let currentFrom = startblock
  while (currentFrom < endblock) {
    const currentTo = Math.min(currentFrom + ASSET_TRANSFERS_MAX_RANGE, endblock)

    const [fromTransfers, toTransfers] = await Promise.all([
      fetchAssetTransfers({
        category,
        fromBlock: currentFrom,
        toBlock: currentTo,
        fromAddress: address,
      }),
      fetchAssetTransfers({
        category,
        fromBlock: currentFrom,
        toBlock: currentTo,
        toAddress: address,
      }),
    ])

    allTransfers.push(...fromTransfers, ...toTransfers)
    currentFrom = currentTo + 1
  }

  // 去重
  const seen = new Set<string>()
  return allTransfers.filter((tx) => {
    const key = `${tx.hash}-${tx.from}-${tx.to}-${tx.contractAddress || ''}-${tx.value}`
    if (seen.has(key))
      return false
    seen.add(key)
    return true
  })
}

/**
 * 获取交易数据（兼容 Etherscan getTransactions 接口）
 *
 * 映射关系：
 * - txlist (普通交易)      → nr_getTransactionByAddress category: ['external'] (交易级 from/to)
 * - txlistinternal (内部交易) → nr_getAssetTransfers category: ['internal']
 * - tokentx (ERC20 转账)   → nr_getAssetTransfers category: ['20']
 */
export async function getTransactions<T extends keyof TransactionActionMap>({
  action,
  address,
  startblock = 0,
  endblock = 99999999,
}: {
  action: T
  address: Hex
  startblock?: number
  endblock?: number
}): Promise<TransactionActionMap[T][]> {
  // 如果 endblock 过大，使用链上最新区块号
  const resolvedEndblock = endblock >= 99999999
    ? await getLatestBlockNumber()
    : endblock

  let transfers: NodeRealTransfer[]

  switch (action) {
    case 'txlist':
      // 使用 nr_getTransactionByAddress 获取普通交易（包括 DEX swap 等合约调用）
      transfers = await fetchNormalTransactionsByAddress({
        address,
        startblock,
        endblock: resolvedEndblock,
      })
      return transfers.map(toNormalTransaction) as TransactionActionMap[T][]

    case 'txlistinternal':
      transfers = await fetchAssetTransfersByAddress({
        category: ['internal'],
        address,
        startblock,
        endblock: resolvedEndblock,
      })
      return transfers.map(toInternalTransaction) as TransactionActionMap[T][]

    case 'tokentx':
      transfers = await fetchAssetTransfersByAddress({
        category: ['20'],
        address,
        startblock,
        endblock: resolvedEndblock,
      })
      return transfers.map(toTokenTransaction) as TransactionActionMap[T][]

    default:
      return []
  }
}
