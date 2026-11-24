// Public demo shim for the Marathon Training app.
// Replaces the FastAPI server: Strava routes are served from bundled JSON/GPX,
// and Claude calls replay responses recorded from the real app.
//
// Record mode (?record, only on localhost with the real server on :5000):
// Claude calls are forwarded to the real proxy and responses are saved, then
// window.downloadDemoRecordings() saves demo/ai-responses.json.
(() => {
  const REAL_SERVER = 'http://localhost:5000'
  const RECORD_KEY = 'demo_ai_recordings'
  const isRecording = new URLSearchParams(location.search).has('record')
    && ['localhost', '127.0.0.1'].includes(location.hostname)

  const nativeFetch = window.fetch.bind(window)
  const jsonResponse = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  const textReply = (text) => ({ content: [{ type: 'text', text }] })

  let activitiesPromise = null
  const loadActivities = () => (activitiesPromise ??= nativeFetch('demo/activities.json').then((r) => r.json()))

  let recordedPromise = null
  const loadRecorded = () => (recordedPromise ??= nativeFetch('demo/ai-responses.json')
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({})))

  // Claude calls carry no activity id, so responses are keyed by the last GPX served
  let currentActivityId = 'upload'

  function classifyClaudeRequest(body) {
    const content = body.messages?.[0]?.content
    const promptText = typeof content === 'string'
      ? content
      : (content || []).filter((block) => block.type === 'text').map((block) => block.text).join('\n')
    if (body.max_tokens <= 10) return 'verify'
    if (/Adapt NEXT DAY ONLY/.test(promptText)) return 'adapt'
    if (/GPS running route/.test(promptText)) return 'shape'
    if (/<svg|SVG/.test(promptText)) return 'svg'
    return 'coach'
  }

  const FALLBACKS = {
    verify: 'YES',
    svg: '',
    shape: JSON.stringify({ shape: 'abstract squiggle', confidence: 'low', description: 'Demo mode: live route-shape matching runs only on the private server.' }),
    adapt: JSON.stringify({ adapt: false, reason: 'Demo mode: plan adaptation uses the live Claude API, which is disabled in this public demo.' }),
    coach: 'Demo mode: AI coaching runs through the Claude API on my private server. Import one of the listed Strava runs to see a recorded coaching response.',
  }

  async function handleClaude(init) {
    const body = JSON.parse(init.body)
    const kind = classifyClaudeRequest(body)
    const key = `${kind}:${currentActivityId}`

    if (isRecording) {
      const res = await nativeFetch(`${REAL_SERVER}/anthropic/messages`, init)
      const payload = await res.clone().json()
      const text = payload.content?.find((block) => block.type === 'text')?.text
      if (text != null && kind !== 'verify') {
        const saved = JSON.parse(localStorage.getItem(RECORD_KEY) || '{}')
        saved[key] = text
        localStorage.setItem(RECORD_KEY, JSON.stringify(saved))
        console.log(`[demo] recorded ${key}`)
      }
      return res
    }

    const recorded = await loadRecorded()
    // Small delay so the UI's loading states are visible, as with a real call
    await new Promise((resolve) => setTimeout(resolve, 600))
    return jsonResponse(textReply(recorded[key] ?? FALLBACKS[kind]))
  }

  async function handleStrava(path, url) {
    const activities = await loadActivities()
    if (path === '/strava/status') {
      return jsonResponse({ connected: true, athlete: { firstname: 'Demo', lastname: 'Athlete' } })
    }
    if (path === '/strava/activities') {
      // Demo data is a fixed snapshot, so ignore the days filter
      return jsonResponse({ count: activities.length, activities })
    }
    if (path === '/strava/latest') {
      return activities.length ? jsonResponse(activities[0]) : jsonResponse({ detail: 'No runs' }, 404)
    }
    const gpxMatch = path.match(/^\/strava\/gpx\/(\d+)$/)
    if (gpxMatch) {
      currentActivityId = gpxMatch[1]
      return nativeFetch(`demo/gpx/${gpxMatch[1]}.gpx`)
    }
    if (path === '/strava/connect') return jsonResponse({ detail: 'Demo mode' }, 400)
    return nativeFetch(url)
  }

  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url
    const parsed = new URL(url, location.href)
    if (parsed.pathname.endsWith('/anthropic/messages') || parsed.hostname === 'api.anthropic.com') {
      return handleClaude(init)
    }
    if (url === '/plan') return nativeFetch('demo/plan.json')
    if (url.startsWith('/strava/')) return handleStrava(parsed.pathname, url)
    return nativeFetch(input, init)
  }

  // The real app's "Import" buttons may be called with GPX uploads too; reset key for those
  document.addEventListener('change', (event) => {
    if (event.target?.id === 'gpxInput') currentActivityId = 'upload'
  }, true)

  window.downloadDemoRecordings = () => {
    const blob = new Blob([localStorage.getItem(RECORD_KEY) || '{}'], { type: 'application/json' })
    const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'ai-responses.json' })
    link.click()
  }

  document.addEventListener('DOMContentLoaded', () => {
    const banner = document.createElement('div')
    banner.className = 'demo-banner'
    banner.innerHTML = isRecording
      ? 'RECORD MODE: import each run, then run <code>downloadDemoRecordings()</code> in the console.'
      : 'Public demo with a snapshot of real training data. Click <b>Recent Runs</b> and import a run to see the analysis and AI coaching.'
    banner.style.cssText = 'position:sticky;top:0;z-index:9999;padding:8px 16px;font:500 13px/1.4 system-ui,sans-serif;text-align:center;background:#1f2a44;color:#fff'
    document.body.prepend(banner)
  })
})()
