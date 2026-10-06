// Search, filter and sort over the cards; the first screen is inline and the
// rest is fetched from cards.json the first time it is needed. Copy buttons
// and tabs are handled here too.
(function () {
  const grid = document.querySelector('#grid')
  const q = document.querySelector('#q')
  const chips = Array.from(document.querySelectorAll('.chip[data-f]'))
  const sort = document.querySelector('#sort')
  const count = document.querySelector('#count')
  const more = document.querySelector('#more')
  const active = new Set()
  const params = new URLSearchParams(location.search)
  let cards = grid ? Array.from(grid.querySelectorAll('.card')) : []
  let loaded = !grid || Number(grid.dataset.total || 0) <= cards.length
  let loading = null
  let showAll = false

  if (q && params.get('q')) q.value = params.get('q')
  for (const f of (params.get('f') || '').split(',').filter(Boolean)) active.add(f)
  for (const c of chips) if (active.has(c.dataset.f)) c.classList.add('on')
  if (sort && params.get('sort')) sort.value = params.get('sort')

  function loadAll() {
    if (loaded) return Promise.resolve()
    if (loading) return loading
    if (count) count.textContent = 'loading all mods…'
    loading = fetch(grid.dataset.cards)
      .then(r => r.json())
      .then(list => {
        const have = new Set(cards.map(c => c.dataset.slug || c.querySelector('.name a').getAttribute('href')))
        const frag = document.createDocumentFragment()
        const tpl = document.createElement('template')
        for (const item of list) {
          tpl.innerHTML = item.html
          const el = tpl.content.firstElementChild
          if (!el) continue
          const key = el.querySelector('.name a').getAttribute('href')
          if (have.has(key)) continue
          frag.appendChild(el)
          cards.push(el)
        }
        grid.appendChild(frag)
        loaded = true
        if (more) more.remove()
      })
      .catch(() => {
        if (count) count.textContent = 'could not load the rest'
      })
    return loading
  }

  function cmpStr(a, b) { return (a.dataset.name || '').localeCompare(b.dataset.name || '') }

  function apply() {
    const text = (q && q.value || '').trim().toLowerCase()
    const terms = text.split(/\s+/).filter(Boolean)
    const key = sort ? sort.value : 'rank'
    const needsAll = terms.length || active.size || key !== 'rank' || showAll
    if (needsAll && !loaded) {
      loadAll().then(apply)
      return
    }
    let shown = 0
    for (const c of cards) {
      const hay = c.dataset.hay || ''
      const tags = (c.dataset.tags || '').split(' ')
      const ok = terms.every(t => hay.includes(t)) && Array.from(active).every(f => tags.includes(f))
      c.classList.toggle('hidden', !ok)
      if (ok) shown++
    }
    const total = grid ? Number(grid.dataset.total || cards.length) : cards.length
    if (count) count.textContent = shown + ' of ' + total
    if (grid) {
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

  if (q) q.addEventListener('input', apply)
  for (const c of chips) c.addEventListener('click', () => {
    const f = c.dataset.f
    if (active.has(f)) { active.delete(f); c.classList.remove('on') } else { active.add(f); c.classList.add('on') }
    apply()
  })
  if (sort) sort.addEventListener('change', apply)
  if (more) more.addEventListener('click', () => { showAll = true; apply() })
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
