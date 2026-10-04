import { useRef, useState, type FormEvent } from 'react'
import { Button } from '@cloudflare/kumo/components/button'
import { Input } from '@cloudflare/kumo/components/input'
import { Table } from '@cloudflare/kumo/components/table'
import { Dialog } from '@cloudflare/kumo/components/dialog'
import type { Request } from './Recharge'

type Row = Record<string, unknown>
type Batch = {
  batch_id: string
  vouchers: {
    id: string
    code: string
    product_code: string
    expires_at: number
  }[]
}
const text = (value: unknown) =>
  value === null || value === undefined ? '—' : String(value)
const time = (value: unknown) =>
  value
    ? new Date(Number(value)).toLocaleString('zh-CN', { hour12: false })
    : '—'
export function Vouchers({
  rows,
  request,
  onChanged,
}: {
  rows: Row[]
  request: Request
  onChanged: () => void
}) {
  const [batch, setBatch] = useState<Batch | null>(null),
    [copied, setCopied] = useState(false)
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const [revoke, setRevoke] = useState<Row | null>(null)
  const lock = useRef(false)
  async function generate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError('')
    const values = Object.fromEntries(new FormData(e.currentTarget))
    try {
      const result = await request<Batch>('/api/admin/vouchers', {
        ...values,
        quantity: Number(values.quantity),
        expires_in_days: Number(values.expires_in_days),
      })
      setBatch(result)
      setCopied(false)
      onChanged()
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : '生成结果未确认，请先查看批次记录，再决定是否重新生成。',
      )
    } finally {
      setBusy(false)
      lock.current = false
    }
  }
  async function confirmRevoke(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!revoke || lock.current) return
    lock.current = true
    setBusy(true)
    setError('')
    const values = Object.fromEntries(new FormData(e.currentTarget))
    try {
      await request(
        `/api/admin/vouchers/${encodeURIComponent(text(revoke.id))}/revoke`,
        values,
      )
      setRevoke(null)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : '撤销结果未确认，请刷新记录。')
    } finally {
      setBusy(false)
      lock.current = false
    }
  }
  const output = batch?.vouchers.map((v) => v.code).join('\n') ?? ''
  return (
    <>
      <section className="voucher-create" aria-label="批量生成卡密">
        <div className="toolbar">
          <h2>批量生成套餐卡密</h2>
          <a
            href="/redeem"
            className="text-link"
            target="_blank"
            rel="noreferrer"
          >
            打开兑换页 ↗
          </a>
        </div>
        <p className="note">
          生成卡密不扣点。兑换时按所属商户的当前套餐价格冻结点数；商户余额不足或已停用时无法兑换。
        </p>
        <form onSubmit={generate} className="voucher-fields">
          <Input
            label="所属商户 ID"
            name="user_id"
            placeholder="从用户管理中复制商户 ID"
            autoComplete="off"
            required
            disabled={busy}
          />
          <label className="form-field">
            兑换套餐
            <select
              name="product_code"
              disabled={busy}
              defaultValue="x-premium-3m"
            >
              <option value="x-premium-3m">Premium · 3 个月</option>
              <option value="x-premium-6m">Premium · 6 个月</option>
            </select>
          </label>
          <Input
            label="数量（1–100）"
            name="quantity"
            type="number"
            min={1}
            max={100}
            step={1}
            defaultValue={1}
            disabled={busy}
            required
          />
          <Input
            label="有效天数（1–365）"
            name="expires_in_days"
            type="number"
            min={1}
            max={365}
            step={1}
            defaultValue={30}
            disabled={busy}
            required
          />
          <Input
            label="批次名称"
            name="batch_label"
            placeholder="例如：十月 Premium 3 个月"
            maxLength={80}
            disabled={busy}
            required
          />
          <Button type="submit" variant="primary" disabled={busy}>
            {busy && !revoke ? '正在生成…' : '生成卡密'}
          </Button>
        </form>
      </section>
      {error && !revoke && !batch && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <div className="toolbar">
        <h2>卡密记录</h2>
        <span className="note">仅显示末 4 位，完整卡密仅生成时可见</span>
      </div>
      <div className="table-scroll">
        <Table>
          <Table.Header>
            <Table.Row>
              {[
                '卡密 / 批次',
                '所属商户',
                '套餐',
                '状态',
                '有效期',
                '原订单',
                '操作',
              ].map((h) => (
                <Table.Head key={h}>{h}</Table.Head>
              ))}
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {!rows.length && (
              <Table.Row>
                <Table.Cell colSpan={7}>
                  <div className="empty">
                    暂无卡密，生成后可将卡密交付给兑换用户。
                  </div>
                </Table.Cell>
              </Table.Row>
            )}
            {rows.map((row) => {
              const expired =
                row.status === 'active' && Number(row.expires_at) <= Date.now()
              const state = expired ? 'expired' : text(row.status)
              const label: Record<string, string> = {
                active: '可兑换',
                redeemed: '已兑换',
                revoked: '已撤销',
                expired: '已过期',
              }
              return (
                <Table.Row key={text(row.id)}>
                  <Table.Cell>
                    <span className="stack">
                      <code>•••• {text(row.last_four)}</code>
                      <small>
                        {text(row.batch_label)}
                        <br />
                        {text(row.batch_id)}
                      </small>
                    </span>
                  </Table.Cell>
                  <Table.Cell>
                    <span className="stack">
                      <span>{text(row.user_name)}</span>
                      <small>{text(row.user_id)}</small>
                    </span>
                  </Table.Cell>
                  <Table.Cell>
                    {text(row.product_name ?? row.product_code)}
                  </Table.Cell>
                  <Table.Cell>
                    <span className={`status status-${state}`}>
                      {label[state] ?? state}
                    </span>
                  </Table.Cell>
                  <Table.Cell>{time(row.expires_at)}</Table.Cell>
                  <Table.Cell>
                    <span className="stack">
                      <code>{text(row.order_id)}</code>
                      {!!row.order_status && (
                        <small>
                          {(
                            {
                              queued: '排队中',
                              running: '处理中',
                              unknown: '待核对',
                              succeeded: '付款已确认',
                              failed: '失败',
                            } as Record<string, string>
                          )[text(row.order_status)] ?? text(row.order_status)}
                        </small>
                      )}
                    </span>
                  </Table.Cell>
                  <Table.Cell>
                    {row.status === 'active' && (
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          setError('')
                          setRevoke(row)
                        }}
                      >
                        撤销
                      </Button>
                    )}
                  </Table.Cell>
                </Table.Row>
              )
            })}
          </Table.Body>
        </Table>
      </div>
      {batch && (
        <Dialog.Root
          open
          onOpenChange={(open) => {
            if (!open) setBatch(null)
          }}
        >
          <Dialog size="lg" className="x-modal">
            <Dialog.Title className="modal-title">
              已生成 {batch.vouchers.length} 张卡密
            </Dialog.Title>
            <Dialog.Description className="modal-description">
              完整卡密仅显示一次。请立即复制并安全保存，关闭后无法恢复。批次：
              {batch.batch_id}
            </Dialog.Description>
            <textarea
              className="secret-output"
              aria-label="本批次完整卡密"
              readOnly
              value={output}
              autoComplete="off"
              spellCheck={false}
            />
            {error && (
              <p className="notice error" role="alert">
                {error}
              </p>
            )}
            <p role="status" className="note">
              {copied ? '已复制全部卡密。' : '每行一张卡密，请勿公开分享。'}
            </p>
            <div className="modal-footer">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setBatch(null)}
              >
                已保存，关闭
              </Button>
              <Button
                type="button"
                variant="primary"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(output)
                    setCopied(true)
                    setError('')
                  } catch {
                    setError('浏览器不允许自动复制，请选中文本手动复制。')
                  }
                }}
              >
                复制全部卡密
              </Button>
            </div>
          </Dialog>
        </Dialog.Root>
      )}
      {revoke && (
        <Dialog.Root
          open
          onOpenChange={(open) => {
            if (!open && !busy) setRevoke(null)
          }}
        >
          <Dialog size="lg" className="x-modal">
            <form onSubmit={confirmRevoke}>
              <Dialog.Title className="modal-title">
                撤销卡密 · {text(revoke.last_four)}
              </Dialog.Title>
              <Dialog.Description className="modal-description">
                撤销后该卡密不能兑换。仅未兑换的卡密可撤销，已创建订单不受此操作影响。
              </Dialog.Description>
              <Input
                label="撤销原因"
                name="note"
                maxLength={300}
                required
                disabled={busy}
              />
              {error && (
                <p className="notice error" role="alert">
                  {error}
                </p>
              )}
              <div className="modal-footer">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setRevoke(null)}
                  disabled={busy}
                >
                  取消
                </Button>
                <Button type="submit" variant="primary" disabled={busy}>
                  {busy ? '正在撤销…' : '确认撤销'}
                </Button>
              </div>
            </form>
          </Dialog>
        </Dialog.Root>
      )}
    </>
  )
}
