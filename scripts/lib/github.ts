// Minimal GitHub client for the scraper: token discovery, rate-limit aware
// fetch, code/repo search pagination, trees and raw file reads.

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const API = 'https://api.github.com'
const CACHE_DIR = join(process.cwd(), '.cache', 'gh')

export type SearchCodeItem = {
  name: string
  path: string
  sha: string
  repository: { full_name: string; private: boolean; fork: boolean; default_branch?: string }
}

export type RepoMeta = {
  full_name: string
  html_url: string
  description: string | null
  homepage: string | null
  stargazers_count: number
  forks_count: number
  license: { spdx_id: string | null; name: string } | null
  pushed_at: string
  created_at: string
  updated_at: string
  default_branch: string
  archived: boolean
  fork: boolean
  topics: string[]
  owner: { login: string; avatar_url: string; html_url: string; type: string }
}

export type TreeEntry = { path: string; type: 'blob' | 'tree' | 'commit'; size?: number; sha: string }

let token: string | undefined
export async function getToken(): Promise<string | undefined> {
  if (token !== undefined) return token || undefined
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
  if (!token) {
    try {
      const p = Bun.spawnSync(['gh', 'auth', 'token'])
      if (p.exitCode === 0) token = new TextDecoder().decode(p.stdout).trim()
    } catch {}
  }
  return token || undefined
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

let lastSearchAt = 0
const SEARCH_GAP_MS = 6500 // code search: 10 requests/minute authenticated

async function ghFetch(url: string, init: RequestInit = {}, attempt = 0): Promise<Response> {
  const t = await getToken()
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'slopshopper-scraper',
    ...(init.headers as Record<string, string> | undefined),
  }
  if (t) headers.Authorization = `Bearer ${t}`
  const res = await fetch(url, { ...init, headers })
  if ((res.status === 403 || res.status === 429) && attempt < 5) {
    const reset = Number(res.headers.get('x-ratelimit-reset') || 0) * 1000
    const retryAfter = Number(res.headers.get('retry-after') || 0) * 1000
    const wait = retryAfter || Math.max(5000, reset - Date.now() + 1000)
    const capped = Math.min(wait, 120_000)
    console.warn(`  rate limited (${res.status}); waiting ${Math.round(capped / 1000)}s`)
    await sleep(capped)
    return ghFetch(url, init, attempt + 1)
  }
  if (res.status >= 500 && attempt < 3) {
    await sleep(2000 * (attempt + 1))
    return ghFetch(url, init, attempt + 1)
  }
  const remaining = Number(res.headers.get('x-ratelimit-remaining') ?? 1000)
  if (remaining < 30 && !url.includes('/search/')) {
    const reset = Number(res.headers.get('x-ratelimit-reset') || 0) * 1000
    const wait = Math.min(Math.max(0, reset - Date.now() + 1000), 300_000)
    if (wait > 0) {
      console.warn(`  core rate limit nearly spent; waiting ${Math.round(wait / 1000)}s`)
      await sleep(wait)
    }
  }
  return res
}

export async function api<T>(path: string): Promise<T | null> {
  const res = await ghFetch(`${API}${path}`)
  if (res.status === 404) return null
  if (!res.ok) {
    console.warn(`  GET ${path} -> ${res.status}`)
    return null
  }
  return (await res.json()) as T
}

/** Paginated code search. Stops at GitHub's 1000-result cap. */
export async function searchCode(q: string, opts: { sort?: 'indexed'; order?: 'asc' | 'desc'; maxPages?: number } = {}): Promise<SearchCodeItem[]> {
  const out: SearchCodeItem[] = []
  const maxPages = opts.maxPages ?? 10
  for (let page = 1; page <= maxPages; page++) {
    const gap = SEARCH_GAP_MS - (Date.now() - lastSearchAt)
    if (gap > 0) await sleep(gap)
    lastSearchAt = Date.now()
    const params = new URLSearchParams({ q, per_page: '100', page: String(page) })
    if (opts.sort) params.set('sort', opts.sort)
    if (opts.order) params.set('order', opts.order)
    const res = await ghFetch(`${API}/search/code?${params}`)
    if (!res.ok) {
      console.warn(`  code search "${q}" page ${page} -> ${res.status} ${(await res.text()).slice(0, 120)}`)
      break
    }
    const json = (await res.json()) as { total_count: number; items: SearchCodeItem[] }
    out.push(...json.items)
    if (page === 1) console.log(`  "${q}"${opts.sort ? ` (${opts.sort} ${opts.order})` : ''}: ${json.total_count} hits`)
    if (json.items.length < 100) break
  }
  return out
}

export async function searchRepos(q: string, maxPages = 3): Promise<string[]> {
  const names: string[] = []
  for (let page = 1; page <= maxPages; page++) {
    const gap = SEARCH_GAP_MS - (Date.now() - lastSearchAt)
    if (gap > 0) await sleep(gap)
    lastSearchAt = Date.now()
    const params = new URLSearchParams({ q, per_page: '100', page: String(page), sort: 'updated', order: 'desc' })
    const res = await ghFetch(`${API}/search/repositories?${params}`)
    if (!res.ok) {
      console.warn(`  repo search "${q}" -> ${res.status}`)
      break
    }
    const json = (await res.json()) as { total_count: number; items: { full_name: string }[] }
    if (page === 1) console.log(`  repos "${q}": ${json.total_count} hits`)
    names.push(...json.items.map(i => i.full_name))
    if (json.items.length < 100) break
  }
  return names
}

export async function repoMeta(fullName: string): Promise<RepoMeta | null> {
  return api<RepoMeta>(`/repos/${fullName}`)
}

export async function repoTree(fullName: string, ref: string): Promise<TreeEntry[] | null> {
  const json = await api<{ tree: TreeEntry[]; truncated: boolean }>(`/repos/${fullName}/git/trees/${encodeURIComponent(ref)}?recursive=1`)
  if (!json) return null
  if (json.truncated) console.warn(`  tree truncated for ${fullName}`)
  return json.tree
}

export async function lastCommitDate(fullName: string, path: string): Promise<string | null> {
  const params = new URLSearchParams({ per_page: '1' })
  if (path) params.set('path', path)
  const json = await api<{ commit: { committer: { date: string } } }[]>(`/repos/${fullName}/commits?${params}`)
  return json?.[0]?.commit?.committer?.date ?? null
}

/** Raw file read via raw.githubusercontent.com (not metered against the core API). */
export async function rawFile(fullName: string, ref: string, path: string, maxBytes = 512_000): Promise<string | null> {
  await mkdir(CACHE_DIR, { recursive: true })
  const url = `https://raw.githubusercontent.com/${fullName}/${ref}/${path.split('/').map(encodeURIComponent).join('/')}`
  const key = join(CACHE_DIR, Bun.hash(url).toString(16))
  const cached = Bun.file(key)
  if (await cached.exists()) return cached.text()
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': 'slopshopper-scraper' } })
    if (res.status === 404) return null
    if (res.status === 429 || res.status >= 500) {
      await sleep(3000 * (attempt + 1))
      continue
    }
    if (!res.ok) return null
    const buf = await res.arrayBuffer()
    if (buf.byteLength > maxBytes) return null
    const text = new TextDecoder().decode(buf)
    await Bun.write(key, text)
    return text
  }
  return null
}
