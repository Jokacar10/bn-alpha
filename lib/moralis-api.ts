import process from 'node:process'
import axios from 'axios'

const MORALIS_API_KEY = process.env.MORALIS_API_KEY || ''
const MORALIS_BASE_URL = 'https://deep-index.moralis.io/api/v2.2'

// BSC 链 ID
const BSC_CHAIN = '0x38'

interface MoralisDateToBlockResponse {
  date: string // ISO 8601 format: "2020-01-01T00:00:00+00:00"
  block: number
  timestamp: number // Unix timestamp in seconds
}

const moralisClient = axios.create({
  baseURL: MORALIS_BASE_URL,
  headers: {
    'X-API-Key': MORALIS_API_KEY,
    'Content-Type': 'application/json',
  },
})

moralisClient.interceptors.response.use(
  (response) => {
    return response
  },
  (error) => {
    console.error('Moralis API error:', error.response?.data || error.message)
    return Promise.reject(error)
  },
)

/**
 * 根据时间戳获取区块号
 * 使用 Moralis /dateToBlock 端点
 * 与 Etherscan API 的 getblocknobytime 行为一致
 */
export async function getBlockNumberByTimestamp(timestamp: number): Promise<number> {
  try {
    // 将 Unix 时间戳转换为 ISO 8601 格式
    const date = new Date(timestamp * 1000).toISOString()

    const res = await moralisClient.get<MoralisDateToBlockResponse>('/dateToBlock', {
      params: {
        chain: BSC_CHAIN,
        date,
      },
    })

    return res.data.block
  }
  catch (error) {
    console.error('Failed to get block by timestamp:', error)
    // 如果 API 调用失败，返回 99999999（与 Etherscan 默认行为一致）
    return 99999999
  }
}
