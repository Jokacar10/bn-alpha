import { NextResponse } from 'next/server'
import { getBlockNumberByTimestamp } from '@/lib/moralis-api'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const timestamp = Number(searchParams.get('timestamp') || '0')

  if (!timestamp) {
    return NextResponse.json({ error: 'Timestamp is required' }, { status: 400 })
  }
  const blockNumber = await getBlockNumberByTimestamp(timestamp)
  return NextResponse.json(blockNumber)
}
