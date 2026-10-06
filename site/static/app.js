// Search, filter and sort over the pre-rendered cards; copy buttons; tabs.
(function () {
  const grid = document.querySelector('#grid')
  const cards = grid ? Array.from(grid.querySelectorAll('.card')) : []
  const q = document.querySelector('#q')
  const chips = Array.from(document.querySelectorAll('.chip[data-f]'))
  const sort = document.querySelector('#sort')
  const count = document.querySelector('#count')
  const active = new Set()
  const params = new URLSearchParams(location.search)
  if (q && params.get('q')) q.value = params.get('q')
  for (const f of (params.get('f') || '').split(',').filter(Boolean)) active.add(f)
  for (const c of chips) if (active.has(c.dataset.f)) c.classList.add('on')
  if (sort && params.get('sort')) sort.value = params.get('sort')

  function apply() {
    const text = (q && q.value || '').trim().toLowerCase()
    const terms = text.split(/\s+/).filter(Boolean)
    let shown = 0
    for (const c of cards) {
      const hay = c.dataset.hay || ''
      const tags = (c.dataset.tags || '').split(' ')
      const okText = terms.every(t => hay.includes(t))
      const okTags = Array.from(active).every(f => tags.includes(f))
      const ok = okText && okTags
      c.classList.toggle('hidden', !ok)
      if (ok) shown++
    }
    if (count) count.textContent = shown + ' of ' + cards.length
    if (sort && grid) {
      const key = sort.value
      const sorted = cards.slice().sort((a, b) => {
        if (key === 'stars') return Number(b.dataset.stars) - Number(a.dataset.stars) || cmpStr(a, b)
        if (key === 'new') return Number(b.dataset.seen) - Number(a.dataset.seen) || cmpStr(a, b)
        if (key === 'updated') return Number(b.dataset.updated) - Number(a.dataset.updated) || cmpStr(a, b)
        if (key === 'name') return cmpStr(a, b)
        return Number(b.dataset.rank) - Number(a.dataset.rank) || cmpStr(a, b)
      })
      for (const c of sorted) grid.appendChild(c)
    }
    const p = new URLSearchParams()
    if (text) p.set('q', text)
    if (active.size) p.set('f', Array.from(active).join(','))
    if (sort && sort.value !== 'rank') p.set('sort', sort.value)
    const qs = p.toString()
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''))
  }
  function cmpStr(a, b) { return (a.dataset.name || '').localeCompare(b.dataset.name || '') }
  if (q) q.addEventListener('input', apply)
  for (const c of chips) c.addEventListener('click', () => {
    const f = c.dataset.f
    if (active.has(f)) { active.delete(f); c.classList.remove('on') } else { active.add(f); c.classList.add('on') }
    apply()
  })
  if (sort) sort.addEventListener('change', apply)
  if (cards.length) apply()

  document.addEventListener('click', e => {
    const b = e.target.closest('button[data-copy]')
    if (b) {
      const text = b.dataset.copy
      navigator.clipboard && navigator.clipboard.writeText(text).then(() => {
        const old = b.textContent
        b.textContent = 'copied'
        setTimeout(() => (b.textContent = old), 1200)
      })
    }
    const t = e.target.closest('.tabs button[data-tab]')
    if (t) {
      const box = t.closest('.tabbed')
      for (const x of box.querySelectorAll('.tabs button')) x.classList.toggle('on', x === t)
      for (const x of box.querySelectorAll('.tab')) x.classList.toggle('on', x.dataset.tab === t.dataset.tab)
    }
  })
})()
