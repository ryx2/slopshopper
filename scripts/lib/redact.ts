// Redacts secret-shaped strings from captured source files and READMEs
// before they are stored or published. Community repositories carry test
// fixtures and example keys; the site never needs the real bytes, and
// GitHub's push protection refuses commits that contain them.

type Pattern = { kind: string; re: RegExp }

const PATTERNS: Pattern[] = [
  { kind: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'openai-key', re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g },
  { kind: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g },
  { kind: 'aws-access-key', re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[0-9A-Z]{16}\b/g },
  { kind: 'aws-secret', re: /\b(?:aws_secret_access_key|secret_access_key)\s*[=:]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/gi },
  { kind: 'slack-token', re: /\bxox[abprse]-[A-Za-z0-9-]{10,}/g },
  { kind: 'slack-webhook', re: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{20,}/g },
  { kind: 'stripe-key', re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: 'stripe-webhook', re: /\bwhsec_[A-Za-z0-9]{24,}/g },
  { kind: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'google-oauth', re: /\b[0-9]+-[a-z0-9_]{20,}\.apps\.googleusercontent\.com\b/g },
  { kind: 'sendgrid-key', re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g },
  { kind: 'twilio-key', re: /\bSK[0-9a-fA-F]{32}\b/g },
  { kind: 'npm-token', re: /\bnpm_[A-Za-z0-9]{30,}/g },
  { kind: 'pypi-token', re: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{20,}/g },
  { kind: 'huggingface-token', re: /\bhf_[A-Za-z0-9]{30,}/g },
  { kind: 'discord-token', re: /\b[MN][A-Za-z0-9]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/g },
  { kind: 'discord-webhook', re: /https:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{30,}/g },
  { kind: 'telegram-token', re: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g },
  { kind: 'linear-key', re: /\blin_api_[A-Za-z0-9]{30,}/g },
  { kind: 'vercel-token', re: /\bvercel_[A-Za-z0-9]{20,}/g },
  { kind: 'supabase-key', re: /\bsbp_[A-Za-z0-9]{30,}/g },
  { kind: 'private-key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g },
  { kind: 'password-url', re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqps?|mssql|ftp|smtp):\/\/[^\s:@/'"]+:([^\s@/'"]{4,})@/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/g },
]

/** `text` with secret-shaped strings replaced by a labeled marker, and the kinds found. */
export function redactText(text: string): { text: string; kinds: string[] } {
  const kinds = new Set<string>()
  let out = text
  for (const p of PATTERNS) {
    p.re.lastIndex = 0
    if (!p.re.test(out)) continue
    kinds.add(p.kind)
    p.re.lastIndex = 0
    out = out.replace(p.re, (whole: string, ...groups: unknown[]) => {
      if (p.kind === 'password-url') return whole.replace(String(groups[0]), 'REDACTED')
      if (p.kind === 'aws-secret') return whole.replace(/[A-Za-z0-9/+=]{40}/, 'REDACTED-BY-SLOPSHOPPER')
      return `REDACTED-${p.kind.toUpperCase()}-BY-SLOPSHOPPER`
    })
  }
  return { text: out, kinds: [...kinds] }
}

export function redactFiles(files: Record<string, string>): { files: Record<string, string>; kinds: string[] } {
  const kinds = new Set<string>()
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(files)) {
    const r = redactText(v)
    out[k] = r.text
    for (const kind of r.kinds) kinds.add(kind)
  }
  return { files: out, kinds: [...kinds] }
}
