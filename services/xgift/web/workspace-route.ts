export const adminSections = ['overview', 'orders', 'platform-orders', 'vouchers', 'admission', 'payment', 'cards', 'users', 'ledger', 'products', 'secrets', 'webhooks', 'audit'] as const
export const merchantSections = ['overview', 'orders', 'vouchers', 'keys', 'ledger', 'docs'] as const
export type WorkspaceSection = typeof adminSections[number] | typeof merchantSections[number]

export function workspaceRoute(hash: string): { section: WorkspaceSection; page: number } {
  const [name, query = ''] = hash.replace(/^#/, '').split('?', 2)
  const section = [...adminSections, ...merchantSections].includes(name as WorkspaceSection) ? name as WorkspaceSection : 'overview'
  const rawPage = new URLSearchParams(query).get('page') ?? '1'
  const page = /^[1-9][0-9]{0,5}$/.test(rawPage) ? Math.min(Number(rawPage), 100000) : 1
  return { section, page }
}

export function workspaceHref(section: WorkspaceSection, page = 1) {
  return `#${section}${page > 1 ? `?page=${page}` : ''}`
}

/** These views own their filters and must stay mounted when their page changes. */
export function hasOwnPagination(section: WorkspaceSection, isAdmin: boolean) {
  return section === 'vouchers' || (isAdmin && ['orders', 'platform-orders'].includes(section))
}
