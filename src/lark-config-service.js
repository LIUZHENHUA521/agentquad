const MASK_PREFIX = 'lark_***'

export function maskLarkAppSecret(secret) {
  if (!secret || typeof secret !== 'string') return null
  const tail = secret.length >= 4 ? secret.slice(-4) : secret
  return MASK_PREFIX + tail
}

export function isMaskedLarkAppSecret(value) {
  return typeof value === 'string' && value.startsWith(MASK_PREFIX)
}

export function larkAppSecretSource(config) {
  const secret = config?.lark?.appSecret
  return secret && typeof secret === 'string' ? 'agentquad' : 'missing'
}
