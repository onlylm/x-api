import type { Request } from './Recharge'

/** Scope the existing form to one merchant without exposing a merchant API key. */
export function adminGiftRequest(request: Request, merchantId: string): Request {
  return async <T,>(path: string, body?: Record<string, unknown>) => {
    if (path === '/api/capabilities') return request<T>(path)
    const match = path.match(/^\/api\/(products|eligibility|orders)(\?.*)?$/)
    if (!match || !/^usr_[a-f0-9]{32}$/.test(merchantId)) throw new Error('请先选择扣点商户。')
    return request<T>(`/api/admin/users/${merchantId}/gift/${match[1]}${match[2] || ''}`, body ? { ...body, confirmation: 'GIFT' } : undefined)
  }
}
