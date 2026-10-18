import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from 'react'
import './App.css'

type MonitorStatus = 'Up' | 'Down' | 'Degraded' | 'Unknown'
type WebhookStatus = 'Pending' | 'Sent' | 'Failed' | 'Retrying'

type Monitor = {
  id: string
  name: string
  url: string
  intervalSeconds: number
  status: MonitorStatus
  isActive: boolean
  createdAt: string
  lastCheck?: {
    isSuccess: boolean
    responseTimeMs: number
    statusCode: number
    checkedAt: string
  }
}

type Webhook = {
  id: string
  targetUrl: string
  payload: string
  attemptCount: number
  status: WebhookStatus
  lastError?: string | null
  receivedAt: string
  lastAttemptAt?: string | null
  deliveredAt?: string | null
}

type MonitorForm = {
  name: string
  url: string
  intervalSeconds: string
}

const API_BASE_URL = import.meta.env.VITE_API_URL || ''
const emptyMonitorForm: MonitorForm = {
  name: '',
  url: 'https://example.com/health',
  intervalSeconds: '30',
}

async function readError(response: Response, fallback: string) {
  try {
    const body = await response.json()
    return body.error ?? body.title ?? fallback
  } catch {
    return fallback
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
  })

  if (!response.ok) {
    throw new Error(await readError(response, `A API respondeu HTTP ${response.status}.`))
  }

  return (await response.json()) as T
}

function App() {
  const [monitors, setMonitors] = useState<Monitor[]>([])
  const [webhooks, setWebhooks] = useState<Webhook[]>([])
  const [loading, setLoading] = useState(true)
  const [apiAvailable, setApiAvailable] = useState<boolean | null>(null)
  const [apiError, setApiError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [monitorForm, setMonitorForm] = useState<MonitorForm>(emptyMonitorForm)
  const [webhookTarget, setWebhookTarget] = useState('http://localhost:8080/mock/webhook-receiver')
  const [webhookPayload, setWebhookPayload] = useState('{"message":"Teste de webhook","source":"dashboard"}')

  const loadData = useCallback(async () => {
    try {
      const [monitorData, webhookData] = await Promise.all([
        fetchJson<Monitor[]>(`${API_BASE_URL}/api/monitors`),
        fetchJson<Webhook[]>(`${API_BASE_URL}/api/webhooks`),
      ])
      setMonitors(monitorData)
      setWebhooks(webhookData)
      setApiAvailable(true)
      setApiError(null)
    } catch (loadError) {
      setApiAvailable(false)
      setApiError(
        loadError instanceof TypeError
          ? 'Não foi possível conectar ao backend. Confirme que a API está ativa em http://localhost:8080.'
          : loadError instanceof Error
            ? loadError.message
            : 'Falha ao carregar os dados da API.',
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadData()
    const interval = window.setInterval(() => void loadData(), 10_000)
    return () => window.clearInterval(interval)
  }, [loadData])

  const refreshData = () => {
    setLoading(true)
    void loadData()
  }

  const metrics = useMemo(() => ({
    activeMonitors: monitors.filter((monitor) => monitor.isActive).length,
    upMonitors: monitors.filter((monitor) => monitor.status === 'Up').length,
    downMonitors: monitors.filter((monitor) => monitor.status === 'Down').length,
    pendingWebhooks: webhooks.filter((webhook) =>
      webhook.status === 'Pending' || webhook.status === 'Failed' || webhook.status === 'Retrying',
    ).length,
  }), [monitors, webhooks])

  const handleMonitorChange = (event: ChangeEvent<HTMLInputElement>) => {
    const { name, value } = event.target
    setMonitorForm((current) => ({ ...current, [name]: value }))
  }

  const handleSaveMonitor = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusyAction(true)
    setNotice(null)
    try {
      const method = editingId ? 'PUT' : 'POST'
      const url = editingId
        ? `${API_BASE_URL}/api/monitors/${editingId}`
        : `${API_BASE_URL}/api/monitors`
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: monitorForm.name.trim(),
          url: monitorForm.url.trim(),
          intervalSeconds: Number(monitorForm.intervalSeconds),
        }),
      })
      if (!response.ok) throw new Error(await readError(response, 'Não foi possível salvar o monitor.'))

      setNotice(editingId ? 'Monitor atualizado.' : 'Monitor adicionado.')
      setEditingId(null)
      setMonitorForm(emptyMonitorForm)
      await loadData()
    } catch (actionError) {
      setNotice(actionError instanceof Error ? actionError.message : 'Falha ao salvar o monitor.')
    } finally {
      setBusyAction(false)
    }
  }

  const startEditing = (monitor: Monitor) => {
    setEditingId(monitor.id)
    setMonitorForm({
      name: monitor.name,
      url: monitor.url,
      intervalSeconds: String(monitor.intervalSeconds),
    })
    setNotice(null)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const cancelEditing = () => {
    setEditingId(null)
    setMonitorForm(emptyMonitorForm)
  }

  const deleteMonitor = async (monitor: Monitor) => {
    if (!window.confirm(`Remover o monitor "${monitor.name}" e seu histórico?`)) return
    setBusyAction(true)
    setNotice(null)
    try {
      const response = await fetch(`${API_BASE_URL}/api/monitors/${monitor.id}`, { method: 'DELETE' })
      if (!response.ok) throw new Error(await readError(response, 'Não foi possível remover o monitor.'))
      if (editingId === monitor.id) cancelEditing()
      setNotice(`Monitor "${monitor.name}" removido.`)
      await loadData()
    } catch (actionError) {
      setNotice(actionError instanceof Error ? actionError.message : 'Falha ao remover o monitor.')
    } finally {
      setBusyAction(false)
    }
  }

  const sendWebhook = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusyAction(true)
    setNotice(null)
    try {
      JSON.parse(webhookPayload)
      const response = await fetch(`${API_BASE_URL}/api/webhooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUrl: webhookTarget.trim(), payload: webhookPayload }),
      })
      if (!response.ok) throw new Error(await readError(response, 'Não foi possível enviar o webhook.'))
      setNotice('Webhook enviado para processamento; veja o resultado na lista.')
      await loadData()
    } catch (actionError) {
      setNotice(
        actionError instanceof SyntaxError
          ? 'O payload precisa ser um JSON válido.'
          : actionError instanceof Error
            ? actionError.message
            : 'Falha ao enviar o webhook.',
      )
    } finally {
      setBusyAction(false)
    }
  }

  const retryWebhook = async (webhook: Webhook) => {
    setBusyAction(true)
    setNotice(null)
    try {
      const response = await fetch(`${API_BASE_URL}/api/webhooks/${webhook.id}/retry`, { method: 'POST' })
      if (!response.ok) throw new Error(await readError(response, 'Não foi possível repetir a entrega.'))
      const result = await response.json()
      setNotice(result.message ?? 'Nova tentativa concluída.')
      await loadData()
    } catch (actionError) {
      setNotice(actionError instanceof Error ? actionError.message : 'Falha ao tentar novamente.')
    } finally {
      setBusyAction(false)
    }
  }

  const selectMock = (name: string, path: string) => {
    setMonitorForm((current) => ({ ...current, name, url: `http://localhost:8080/mock/${path}` }))
    setNotice('Endpoint fake selecionado. Inicie também o HealthCheckWorker para atualizar o status.')
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">API Reliability Suite</p>
          <h1>Dashboard de monitoramento</h1>
        </div>
        <div className="topbar-actions">
          <span className={`connection-badge ${apiAvailable === true ? 'connected' : apiAvailable === false ? 'disconnected' : ''}`}>
            <span className="connection-dot" />
            {apiAvailable === true ? 'API conectada' : apiAvailable === false ? 'API indisponível' : 'Conectando...'}
          </span>
          <button className="secondary-button" type="button" onClick={refreshData}>
            Atualizar
          </button>
        </div>
      </header>

      {apiError ? (
        <div className="alert error" role="alert">
          <strong>Backend não conectado</strong>
          <span>{apiError}</span>
          <code>API: http://localhost:8080</code>
        </div>
      ) : null}
      {notice ? <div className="alert notice" role="status">{notice}</div> : null}

      <main className="content">
        <section className="stats-grid">
          <article className="stat-card"><span>Monitores ativos</span><strong>{metrics.activeMonitors}</strong></article>
          <article className="stat-card success"><span>Disponíveis</span><strong>{metrics.upMonitors}</strong></article>
          <article className="stat-card danger"><span>Em falha</span><strong>{metrics.downMonitors}</strong></article>
          <article className="stat-card warning"><span>Webhooks pendentes/falhos</span><strong>{metrics.pendingWebhooks}</strong></article>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>{editingId ? 'Editar monitor' : 'Novo monitor'}</h2>
              <p>O worker faz um GET no endereço e registra o status.</p>
            </div>
            {editingId ? <button className="secondary-button" type="button" onClick={cancelEditing}>Cancelar edição</button> : null}
          </div>
          <div className="mock-presets">
            <span>Testes rápidos:</span>
            <button type="button" className="text-button" onClick={() => selectMock('Fake saudável', 'ok')}>Saudável (200)</button>
            <button type="button" className="text-button" onClick={() => selectMock('Fake com erro', 'error')}>Erro (500)</button>
            <button type="button" className="text-button" onClick={() => selectMock('Fake lenta', 'slow')}>Lenta (4s)</button>
          </div>
          <form className="monitor-form" onSubmit={handleSaveMonitor}>
            <label>Nome<input name="name" value={monitorForm.name} onChange={handleMonitorChange} placeholder="API de Pagamentos" required /></label>
            <label>URL<input name="url" type="url" value={monitorForm.url} onChange={handleMonitorChange} placeholder="https://api.exemplo.com/health" required /></label>
            <label>Intervalo (segundos)<input name="intervalSeconds" type="number" min="15" max="3600" value={monitorForm.intervalSeconds} onChange={handleMonitorChange} required /></label>
            <button className="primary-button" type="submit" disabled={busyAction || apiAvailable === false}>
              {busyAction ? 'Salvando...' : editingId ? 'Salvar edição' : 'Adicionar monitor'}
            </button>
          </form>
          <p className="hint">Checks rodam a cada 30 segundos. Para atualizar status, deixe o HealthCheckWorker ativo.</p>
        </section>

        <section className="two-column">
          <article className="panel">
            <div className="panel-header"><div><h2>Monitores</h2><p>Edite ou remova os serviços acompanhados.</p></div></div>
            {loading ? <p className="state-text">Carregando monitores...</p> : monitors.length === 0 ? <p className="state-text">Nenhum monitor cadastrado.</p> : (
              <div className="list">
                {monitors.map((monitor) => (
                  <div className="row-card" key={monitor.id}>
                    <div className="row-main">
                      <div><h3>{monitor.name}</h3><p>{monitor.url}</p></div>
                      <span className={`status-pill ${monitor.status.toLowerCase()}`}>{monitor.status === 'Up' ? 'Disponível' : monitor.status === 'Down' ? 'Fora do ar' : monitor.status === 'Degraded' ? 'Lento/degradado' : 'Aguardando check'}</span>
                    </div>
                    <div className="row-meta">
                      <span>Intervalo: {monitor.intervalSeconds}s</span>
                      <span>Último check: {monitor.lastCheck ? `${new Date(monitor.lastCheck.checkedAt).toLocaleString()} · HTTP ${monitor.lastCheck.statusCode || 'sem resposta'} · ${monitor.lastCheck.responseTimeMs}ms` : 'Ainda sem check'}</span>
                    </div>
                    {monitor.status === 'Unknown' ? <p className="hint">Inicie o worker; ele fará o primeiro teste em até 30 segundos.</p> : null}
                    <div className="row-actions">
                      <button className="secondary-button" type="button" disabled={busyAction} onClick={() => startEditing(monitor)}>Editar</button>
                      <button className="danger-button" type="button" disabled={busyAction} onClick={() => void deleteMonitor(monitor)}>Apagar</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </article>

          <article className="panel">
            <div className="panel-header"><div><h2>Webhooks</h2><p>Enviar evento JSON a um endpoint; entrega não é automática ao criar monitor.</p></div></div>
            <form className="webhook-form" onSubmit={sendWebhook}>
              <label>URL de destino<input type="url" value={webhookTarget} onChange={(event) => setWebhookTarget(event.target.value)} required /></label>
              <label>Payload JSON<textarea rows={4} value={webhookPayload} onChange={(event) => setWebhookPayload(event.target.value)} required /></label>
              <button className="primary-button" type="submit" disabled={busyAction || apiAvailable === false}>Enviar webhook de teste</button>
            </form>
            <p className="hint">O receptor fake pode responder 500 em algumas tentativas para testar o retry. O worker reprocessa entregas falhas.</p>
            {loading ? <p className="state-text">Carregando webhooks...</p> : webhooks.length === 0 ? <p className="state-text">Nenhum webhook enviado.</p> : (
              <div className="list webhook-list">
                {webhooks.slice(0, 6).map((webhook) => (
                  <div className="row-card webhook" key={webhook.id}>
                    <div className="row-main">
                      <div><h3>{webhook.targetUrl}</h3><p>Tentativas: {webhook.attemptCount}</p></div>
                      <span className={`status-pill ${webhook.status.toLowerCase()}`}>{webhook.status}</span>
                    </div>
                    <div className="row-meta"><span>{new Date(webhook.receivedAt).toLocaleString()}</span>{webhook.lastError ? <span>{webhook.lastError}</span> : null}</div>
                    {webhook.status !== 'Sent' ? <div className="row-actions"><button className="secondary-button" type="button" disabled={busyAction} onClick={() => void retryWebhook(webhook)}>Tentar novamente</button></div> : null}
                  </div>
                ))}
              </div>
            )}
          </article>
        </section>
      </main>
    </div>
  )
}

export default App
