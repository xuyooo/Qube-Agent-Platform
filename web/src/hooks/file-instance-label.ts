export function fileInstanceLabel(props: Record<string, unknown>): string | null {
  const path = typeof props.viewingPath === 'string' ? props.viewingPath : ''
  if (!path) return null
  const stripped = path.endsWith('/') ? path.slice(0, -1) : path
  const name = stripped.split('/').pop() || stripped
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}
