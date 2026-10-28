import { type FormEvent, type ReactNode, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import {
  Activity, ArrowDownRight, ArrowUpRight, BookOpen, CalendarDays, Check, ChevronDown,
  CircleAlert, FileSpreadsheet, Headphones, KeyRound, LogOut, MessageCircle,
  RefreshCw, Send, Settings2, ShieldCheck, Trash2, Upload, Users, Video, X,
} from 'lucide-react';
import {
  getGetAdminStatusQueryKey, getGetConversationsQueryKey, getGetDashboardSummaryQueryKey,
  getGetDeliveriesQueryKey, getGetDynamicContentQueryKey, getGetRecordingRequestsQueryKey,
  useApproveRecordingRequest, useCreateAdminSession, useDeleteAdminSession, useDeleteDynamicContent,
  useGetAdminStatus, useGetConversations, useGetDashboardSummary, useGetDeliveries,
  useGetDynamicContent, useGetRecordingRequests, useHealthCheck, useImportTuteDeliveries,
  useInspectTuteDeliveryFile, useSetConversationMode, useUpsertDynamicContent,
} from '@workspace/api-client-react';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 20_000 } },
});
const DELIVERY_WAVES = ['Wave 1', 'Wave 2', 'Wave 3', 'Wave 4'] as const;
const ITEM_TYPES = ['Monthly Tute', 'Special Book'] as const;
type ContentCategory = 'timetable' | 'pricing' | 'general' | 'faq' | 'announcement';
const now = new Date();
const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

function errorText(error: unknown) {
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Please try again.';
}

function dateLabel(value?: string) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString('en-LK', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function AppContent() {
  const client = useQueryClient();
  const [month, setMonth] = useState(currentMonth);
  const [loginKey, setLoginKey] = useState('');
  const [loginError, setLoginError] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [inspection, setInspection] = useState<{ columns: string[]; previewRows: Array<Record<string, string>>; rowCount: number } | null>(null);
  const [columnMap, setColumnMap] = useState({ phoneNumber: '', studentName: '', trackingNumber: '', address: '' });
  const [deliveryWave, setDeliveryWave] = useState<(typeof DELIVERY_WAVES)[number]>('Wave 1');
  const [itemType, setItemType] = useState<(typeof ITEM_TYPES)[number]>('Monthly Tute');
  const [importFeedback, setImportFeedback] = useState('');
  const [importError, setImportError] = useState('');
  const [activeContentKey, setActiveContentKey] = useState('');
  const [contentKey, setContentKey] = useState('');
  const [contentCategory, setContentCategory] = useState('general');
  const [contentTitle, setContentTitle] = useState('');
  const [contentBody, setContentBody] = useState('');
  const [contentFeedback, setContentFeedback] = useState('');
  const [contentError, setContentError] = useState('');
  const [zoomInputs, setZoomInputs] = useState<Record<number, string>>({});
  const [approvingId, setApprovingId] = useState<number | null>(null);
  const [approvalError, setApprovalError] = useState<{ id: number; message: string } | null>(null);
  const [contextTarget, setContextTarget] = useState<number | null>(null);
  const [notice, setNotice] = useState('');

  const statusQuery = useGetAdminStatus({ request: { credentials: 'include' } });
  const health = useHealthCheck({ request: { credentials: 'include' } });
  const status = statusQuery.data;
  const authenticated = Boolean(status?.authenticated);
  const summaryQuery = useGetDashboardSummary({ query: { enabled: authenticated, queryKey: getGetDashboardSummaryQueryKey() }, request: { credentials: 'include' } });
  const conversationsQuery = useGetConversations({ mode: 'all', limit: 100 }, { query: { enabled: authenticated, queryKey: getGetConversationsQueryKey({ mode: 'all', limit: 100 }) }, request: { credentials: 'include' } });
  const deliveriesQuery = useGetDeliveries({ month }, { query: { enabled: authenticated, queryKey: getGetDeliveriesQueryKey({ month }) }, request: { credentials: 'include' } });
  const contentQuery = useGetDynamicContent({ query: { enabled: authenticated, queryKey: getGetDynamicContentQueryKey() }, request: { credentials: 'include' } });
  const recordingsQuery = useGetRecordingRequests({ status: 'all', limit: 100 }, { query: { enabled: authenticated, queryKey: getGetRecordingRequestsQueryKey({ status: 'all', limit: 100 }) }, request: { credentials: 'include' } });
  const createSession = useCreateAdminSession({ request: { credentials: 'include' } });
  const deleteSession = useDeleteAdminSession({ request: { credentials: 'include' } });
  const setMode = useSetConversationMode({ request: { credentials: 'include' } });
  const importDeliveries = useImportTuteDeliveries({ request: { credentials: 'include' } });
  const inspectDeliveryFile = useInspectTuteDeliveryFile({ request: { credentials: 'include' } });
  const upsertContent = useUpsertDynamicContent({ request: { credentials: 'include' } });
  const deleteContent = useDeleteDynamicContent({ request: { credentials: 'include' } });
  const approveRecording = useApproveRecordingRequest({ request: { credentials: 'include' } });

  const conversations = conversationsQuery.data ?? [];
  const deliveries = deliveriesQuery.data ?? [];
  const dynamicContent = contentQuery.data ?? [];
  const recordingRequests = recordingsQuery.data ?? [];
  const selectedContent = useMemo(() => dynamicContent.find((item) => item.key === activeContentKey), [dynamicContent, activeContentKey]);
  const contextRequest = recordingRequests.find((item) => item.id === contextTarget);
  const queue = conversations.filter((item) => item.mode === 'human');

  function loadContent(key: string) {
    setActiveContentKey(key);
    const item = dynamicContent.find((entry) => entry.key === key);
    setContentKey(item?.key ?? '');
    setContentCategory(item?.category ?? 'general');
    setContentTitle(item?.title ?? '');
    setContentBody(item?.content ?? '');
    setContentFeedback('');
    setContentError('');
  }

  async function fileAsBase64(file: File) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result ?? '');
        const separator = result.indexOf(',');
        resolve(separator >= 0 ? result.slice(separator + 1) : result);
      };
      reader.onerror = () => reject(new Error('Could not read this file.'));
      reader.readAsDataURL(file);
    });
  }

  async function inspectFile() {
    if (!selectedFile) return;
    setImportFeedback('');
    setImportError('');
    try {
      const fileData = await fileAsBase64(selectedFile);
      inspectDeliveryFile.mutate({ data: { fileName: selectedFile.name, fileData } }, {
        onSuccess: (result) => {
          setInspection(result);
          const findColumn = (terms: string[]) => result.columns.find((column) => terms.some((term) => column.toLowerCase().replace(/[^a-z]/g, '').includes(term)));
          setColumnMap({
            phoneNumber: findColumn(['phone', 'mobile', 'whatsapp']) ?? '',
            studentName: findColumn(['name', 'student']) ?? '',
            trackingNumber: findColumn(['tracking', 'track', 'waybill']) ?? '',
            address: findColumn(['address', 'delivery']) ?? '',
          });
        },
        onError: (error) => setImportError(errorText(error)),
      });
    } catch (error) {
      setImportError(errorText(error));
    }
  }

  async function handleImport() {
    if (!selectedFile || !inspection || Object.values(columnMap).some((value) => !value)) return;
    setImportFeedback('');
    setImportError('');
    try {
      const fileData = await fileAsBase64(selectedFile);
      importDeliveries.mutate({ data: { month, deliveryWave, itemType, fileName: selectedFile.name, fileData, columnMap } }, {
        onSuccess: (result) => {
          setImportFeedback(`Processed ${result.processed} rows · ${result.inserted} added · ${result.updated} updated · ${result.skipped} skipped.`);
          setImportError(result.errors?.length ? result.errors.join(' · ') : '');
          void client.invalidateQueries({ queryKey: getGetDeliveriesQueryKey({ month }) });
          void client.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
        },
        onError: (error) => setImportError(errorText(error)),
      });
    } catch (error) {
      setImportError(errorText(error));
    }
  }

  function saveContent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setContentError('');
    setContentFeedback('');
    const key = contentKey.trim();
    if (!key || !contentTitle.trim()) {
      setContentError('Add a unique key and a title before saving.');
      return;
    }
    upsertContent.mutate({ key, data: { category: contentCategory as ContentCategory, title: contentTitle.trim(), content: contentBody } }, {
      onSuccess: (saved) => {
        setContentFeedback('Changes saved.');
        setActiveContentKey(saved.key);
        setContentKey(saved.key);
        void client.invalidateQueries({ queryKey: getGetDynamicContentQueryKey() });
        void client.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
      },
      onError: (error) => setContentError(errorText(error)),
    });
  }

  function removeContent() {
    if (!activeContentKey) return;
    if (!window.confirm(`Delete "${selectedContent?.title ?? activeContentKey}"? The assistant will stop using it.`)) return;
    setContentError('');
    setContentFeedback('');
    deleteContent.mutate({ key: activeContentKey }, {
      onSuccess: () => {
        loadContent('');
        setNotice('Entry deleted.');
        void client.invalidateQueries({ queryKey: getGetDynamicContentQueryKey() });
        void client.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
      },
      onError: (error) => setContentError(errorText(error)),
    });
  }

  function confirmApproval(id: number) {
    const zoomLink = (zoomInputs[id] ?? '').trim();
    if (!zoomLink) return;
    setApprovalError(null);
    setApprovingId(id);
    approveRecording.mutate({ id, data: { zoomLink } }, {
      onSettled: () => setApprovingId(null),
      onSuccess: () => {
        setZoomInputs((current) => { const next = { ...current }; delete next[id]; return next; });
        setNotice('Recording link approved and sent via WhatsApp.');
        void client.invalidateQueries({ queryKey: getGetRecordingRequestsQueryKey({ status: 'all', limit: 100 }) });
        void client.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
      },
      onError: (error) => setApprovalError({ id, message: errorText(error) }),
    });
  }

  const integrations: Array<[string, boolean]> = status ? [
    ['Admin key', status.adminConfigured], ['Session secret', status.sessionConfigured],
    ['Database', status.databaseConfigured], ['Gemini', status.geminiConfigured], ['YCloud', status.ycloudConfigured],
  ] : [];
  const missingIntegrations = integrations.filter(([, ready]) => !ready);
  const isBusy = summaryQuery.isLoading || conversationsQuery.isLoading || deliveriesQuery.isLoading || contentQuery.isLoading || recordingsQuery.isLoading;

  return (
    <div className="min-h-[100dvh] text-foreground">
      <div className="app-shell">
        <aside className="sidebar">
          <a href="/" className="brand" aria-label="AL Media Assistant home">
            <span className="brand-mark">AL</span>
            <span><strong>AL Media</strong><small>ASSISTANT DESK</small></span>
          </a>
          <div className="side-label">WORKSPACE</div>
          <nav className="side-nav" aria-label="Workspace navigation">
            <a href="#overview" className="nav-item active"><Activity size={17} />Overview</a>
            <a href="#handoffs" className="nav-item"><MessageCircle size={17} />Live handoffs{authenticated && queue.length > 0 && <span className="nav-count">{queue.length}</span>}</a>
            <a href="#deliveries" className="nav-item"><FileSpreadsheet size={17} />Tute deliveries</a>
            <a href="#content" className="nav-item"><CalendarDays size={17} />Class information</a>
            <a href="#recordings" className="nav-item"><Video size={17} />Recording access</a>
          </nav>
          <div className="sidebar-bottom">
            <div className="system-card">
              <span className={`system-dot ${health.isError ? 'offline' : ''}`} />
              <div><b>System health</b><small>{health.isLoading ? 'Checking services' : health.isError ? 'Health check unavailable' : health.data?.status ?? 'Connected'}</small></div>
              {health.isError && <button className="icon-button" onClick={() => void health.refetch()} aria-label="Retry health check"><RefreshCw size={15} /></button>}
            </div>
            <div className="site-note">Built for <b>mediasuranga.lk</b><br />Staff operations workspace</div>
          </div>
        </aside>

        <main className="main-column">
          <header className="topbar">
            <div className="breadcrumb">Workspace <span>/</span> Overview</div>
            <div className="top-actions">
              <span className="today-date">{now.toLocaleDateString('en-LK', { weekday: 'short', day: 'numeric', month: 'short' })}</span>
              {authenticated ? (
                <button className="button button-quiet" onClick={() => deleteSession.mutate(undefined, {
                  onSuccess: () => { void client.invalidateQueries({ queryKey: getGetAdminStatusQueryKey() }); void client.clear(); },
                })} disabled={deleteSession.isPending}><LogOut size={15} />{deleteSession.isPending ? 'Signing out' : 'Sign out'}</button>
              ) : <span className="access-pill"><ShieldCheck size={14} />Staff access</span>}
            </div>
          </header>

          <div className="content-wrap">
            <section className="welcome-row soft-enter" id="overview">
              <div>
                <div className="eyebrow"><span className="eyebrow-line" />MEDIA SURANGA · ADMIN</div>
                <h1>Good {now.getHours() < 12 ? 'morning' : now.getHours() < 17 ? 'afternoon' : 'evening'}<span className="title-period">.</span></h1>
                <p className="subheading">A clear view of today’s student support and class operations.</p>
              </div>
              <button className="button button-outline refresh-button" onClick={() => {
                void statusQuery.refetch();
                if (authenticated) void Promise.all([summaryQuery.refetch(), conversationsQuery.refetch(), deliveriesQuery.refetch(), contentQuery.refetch(), recordingsQuery.refetch()]);
              }}><RefreshCw size={15} />Refresh workspace</button>
            </section>

            {statusQuery.isLoading && <section className="setup-banner skeleton-banner" aria-label="Loading workspace setup"><span className="skeleton-line wide" /><span className="skeleton-line" /></section>}
            {statusQuery.isError && <section className="setup-banner error-banner"><CircleAlert size={19} /><div><b>Workspace status could not load</b><p>{errorText(statusQuery.error)}</p></div><button className="button button-outline" onClick={() => void statusQuery.refetch()}>Retry</button></section>}

            {status && missingIntegrations.length > 0 && (
              <section className="setup-banner soft-enter" aria-label="Integration setup status">
                <div className="setup-icon"><Settings2 size={19} /></div>
                <div className="setup-copy"><b>Finish connecting your workspace</b><p>Some services are not configured yet. Connect them on the server to enable the full assistant workflow.</p></div>
                <div className="integration-list">
                  {integrations.map(([label, ready]) => <span className={`integration-tag ${ready ? 'ready' : ''}`} key={label}><i />{label}</span>)}
                </div>
              </section>
            )}

            {status && !authenticated && (
              <section className="signin-panel panel soft-enter" aria-labelledby="signin-title">
                <div className="signin-art" aria-hidden="true">
                  <div className="orbit orbit-one" /><div className="orbit orbit-two" />
                  <div className="signin-symbol"><BookOpen size={30} /></div><span className="spark spark-a" /><span className="spark spark-b" />
                </div>
                <div className="signin-copy">
                  <div className="eyebrow">PRIVATE STAFF WORKSPACE</div>
                  <h2 id="signin-title">Sign in to your desk</h2>
                  <p>Your admin key opens the handoff queue, delivery records and class information.</p>
                  <form className="signin-form" onSubmit={(event) => {
                    event.preventDefault(); setLoginError('');
                    createSession.mutate({ data: { key: loginKey } }, {
                      onSuccess: () => { setLoginKey(''); void client.invalidateQueries({ queryKey: getGetAdminStatusQueryKey() }); },
                      onError: (error) => setLoginError(errorText(error)),
                    });
                  }}>
                    <label className="field-label" htmlFor="admin-key">Admin key</label>
                    <div className="input-with-icon"><KeyRound size={16} /><input id="admin-key" type="password" autoComplete="current-password" value={loginKey} onChange={(event) => setLoginKey(event.target.value)} placeholder="Enter your staff key" required maxLength={512} data-testid="input-admin-key" /></div>
                    {loginError && <p className="inline-error" role="alert">{loginError}</p>}
                    <button className="button button-primary signin-submit" type="submit" disabled={createSession.isPending || !loginKey.trim()}>{createSession.isPending ? 'Signing in…' : 'Continue securely'}<ArrowUpRight size={16} /></button>
                  </form>
                  <span className="secure-note"><ShieldCheck size={13} />Session protected · key is never saved on this device</span>
                </div>
              </section>
            )}

            {authenticated && (
              <>
                {isBusy && <div className="metric-grid" aria-label="Loading summary"><div className="metric-skeleton" /><div className="metric-skeleton" /><div className="metric-skeleton" /><div className="metric-skeleton" /></div>}
                {summaryQuery.isError && <div className="inline-error error-strip" role="alert">Summary failed to load. <button onClick={() => void summaryQuery.refetch()}>Retry</button> · {errorText(summaryQuery.error)}</div>}
                {summaryQuery.data && <section className="metric-grid soft-enter" aria-label="Workspace summary">
                  <Metric icon={<MessageCircle size={17} />} label="Needs a human" value={summaryQuery.data.humanQueueCount} note="Active handoffs" tone="amber" />
                  <Metric icon={<Video size={17} />} label="Recording requests" value={summaryQuery.data.pendingRecordingCount} note="Awaiting approval" tone="teal" />
                  <Metric icon={<FileSpreadsheet size={17} />} label="Tutes this month" value={summaryQuery.data.deliveriesThisMonth} note="Delivery records" tone="coral" />
                  <Metric icon={<Users size={17} />} label="Recent conversations" value={summaryQuery.data.recentConversationCount} note="Student messages" tone="blue" />
                </section>}

                <div className="workspace-grid">
                  <section className="panel section-panel handoff-panel soft-enter" id="handoffs">
                    <SectionHeading number="01" title="Live handoff queue" icon={<MessageCircle size={17} />} count={queue.length} description="Students waiting for a staff reply" />
                    {conversationsQuery.isLoading ? <LoadingRows /> : conversationsQuery.isError ? <ErrorState message={errorText(conversationsQuery.error)} retry={() => void conversationsQuery.refetch()} /> : queue.length === 0 ? <EmptyState title="All caught up" detail="There are no conversations waiting for a staff member." /> : (
                      <div className="handoff-list">
                        {queue.map((conversation) => <article className="handoff-item" key={conversation.phoneNumber} data-testid={`conversation-${conversation.phoneNumber}`}>
                          <div className="avatar">{(conversation.studentName?.trim()?.[0] ?? 'S').toUpperCase()}</div>
                          <div className="handoff-main">
                            <div className="name-line"><strong>{conversation.studentName || 'Student'}</strong><span className="mono-number">{conversation.phoneNumber}</span></div>
                            <div className="conversation-context"><span>{conversation.batch === 'unknown' ? 'Batch unassigned' : `Batch ${conversation.batch}`}</span><span className="separator-dot" />{conversation.studentType === 'new' ? 'New student' : 'Existing student'}<span className="separator-dot" />{conversation.lastIntent || 'General enquiry'}</div>
                            {conversation.lastMessage && <p className="message-preview">{conversation.lastMessage}</p>}
                          </div>
                          <div className="handoff-side"><time>{dateLabel(conversation.lastMessageAt)}</time><button className="button button-small button-outline" disabled={setMode.isPending} onClick={() => setMode.mutate({ phoneNumber: conversation.phoneNumber, data: { mode: 'bot' } }, {
                            onSuccess: () => { setNotice('Conversation returned to assistant mode.'); void client.invalidateQueries({ queryKey: getGetConversationsQueryKey({ mode: 'all', limit: 100 }) }); void client.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() }); },
                          })}>Return to assistant</button></div>
                        </article>)}
                      </div>
                    )}
                    {conversationsQuery.isError && null}
                  </section>

                  <section className="panel section-panel delivery-panel soft-enter" id="deliveries">
                    <SectionHeading number="02" title="Monthly tute delivery" icon={<FileSpreadsheet size={17} />} description="Spreadsheet sync and records" />
                    <div className="delivery-controls">
                      <label className="field-label" htmlFor="delivery-month">Delivery month</label>
                      <input id="delivery-month" className="input month-input" type="month" value={month} onChange={(event) => setMonth(event.target.value)} data-testid="input-delivery-month" />
                       <label className="field-label" htmlFor="delivery-wave">Delivery wave</label>
                       <div className="select-wrap"><select id="delivery-wave" className="input" value={deliveryWave} onChange={(event) => setDeliveryWave(event.target.value as (typeof DELIVERY_WAVES)[number])} data-testid="select-delivery-wave">{DELIVERY_WAVES.map((wave) => <option key={wave} value={wave}>{wave}</option>)}</select><ChevronDown size={14} /></div>
                       <label className="field-label" htmlFor="delivery-item">Item type</label>
                       <div className="select-wrap"><select id="delivery-item" className="input" value={itemType} onChange={(event) => setItemType(event.target.value as (typeof ITEM_TYPES)[number])} data-testid="select-item-type">{ITEM_TYPES.map((item) => <option key={item} value={item}>{item}</option>)}</select><ChevronDown size={14} /></div>
                    </div>
                    <label className={`upload-zone ${selectedFile ? 'has-file' : ''}`} htmlFor="delivery-file">
                      <input id="delivery-file" type="file" accept=".csv,.xlsx,.xls,.ods" onChange={(event) => { setSelectedFile(event.target.files?.[0] ?? null); setInspection(null); setImportFeedback(''); setImportError(''); }} data-testid="input-delivery-file" />
                      <span className="upload-icon"><Upload size={19} /></span>
                      <span className="upload-label">{selectedFile ? selectedFile.name : 'Choose a delivery spreadsheet'}</span>
                      <span className="upload-help">{selectedFile ? `${(selectedFile.size / 1024).toFixed(1)} KB · ${deliveryWave} · ${itemType}` : 'CSV or Excel · select file to begin'}</span>
                    </label>
                    <button className="button button-outline full-button" onClick={inspectFile} disabled={!selectedFile || inspectDeliveryFile.isPending}>
                      {inspectDeliveryFile.isPending ? <><RefreshCw className="spin-icon" size={15} />Reading spreadsheet…</> : <><FileSpreadsheet size={15} />Inspect spreadsheet</>}
                    </button>
                    {inspection && <div className="import-preview">
                      <div className="preview-heading"><b>Spreadsheet preview</b><span>{inspection.rowCount} rows · {inspection.columns.length} columns</span></div>
                      <p>Match each AL Media field to the correct source column before importing.</p>
                      <div className="mapping-grid">
                        {([
                          ['phoneNumber', 'Phone number'],
                          ['studentName', 'Student name'],
                          ['trackingNumber', 'Tracking number'],
                          ['address', 'Delivery address'],
                        ] as const).map(([field, label]) => <label className="field-group" key={field}>
                          <span className="field-label">{label}</span>
                          <div className="select-wrap"><select className="input mapping-select" value={columnMap[field]} onChange={(event) => setColumnMap((current) => ({ ...current, [field]: event.target.value }))} aria-label={`Map ${label}`} data-testid={`select-map-${field}`}>
                            <option value="">Choose column…</option>{inspection.columns.map((column) => <option value={column} key={column}>{column}</option>)}
                          </select><ChevronDown size={14} /></div>
                        </label>)}
                      </div>
                      {inspection.previewRows.length > 0 && <div className="preview-table-wrap"><table className="delivery-table preview-table"><thead><tr>{inspection.columns.slice(0, 4).map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{inspection.previewRows.slice(0, 3).map((row, index) => <tr key={index}>{inspection.columns.slice(0, 4).map((column) => <td key={column}>{row[column] || '—'}</td>)}</tr>)}</tbody></table></div>}
                      <button className="button button-primary full-button" onClick={handleImport} disabled={Object.values(columnMap).some((value) => !value) || importDeliveries.isPending}>
                        {importDeliveries.isPending ? <><RefreshCw className="spin-icon" size={15} />Importing records…</> : <><Upload size={15} />Import mapped records</>}
                      </button>
                    </div>}
                    {importFeedback && <div className="feedback success-feedback" role="status"><Check size={15} />{importFeedback}</div>}
                    {importError && <div className="feedback error-feedback" role="alert"><CircleAlert size={15} />{importError}</div>}
                    <div className="table-heading"><span>RECORDS FOR {month}</span><span>{deliveriesQuery.isLoading ? '…' : deliveries.length} records</span></div>
                    {deliveriesQuery.isLoading ? <LoadingRows compact /> : deliveriesQuery.isError ? <ErrorState message={errorText(deliveriesQuery.error)} retry={() => void deliveriesQuery.refetch()} /> : deliveries.length === 0 ? <p className="small-empty">No delivery records for this month yet.</p> : (
                      <div className="delivery-table-wrap"><table className="delivery-table"><thead><tr><th>Student</th><th>Item</th><th>Tracking</th><th>Status</th></tr></thead><tbody>
                        {deliveries.slice(0, 7).map((delivery) => <tr key={delivery.id}><td><b>{delivery.studentName || 'Student'}</b><small>{delivery.phoneNumber}</small></td><td><span className="status-badge">{delivery.itemType}</span><small>{delivery.deliveryWave}</small></td><td className="font-mono-ui">{delivery.trackingNumber}</td><td><span className={`status-badge ${delivery.status.toLowerCase()}`}>{delivery.status}</span></td></tr>)}
                      </tbody></table>{deliveries.length > 7 && <div className="table-foot">Showing 7 of {deliveries.length} delivery records</div>}</div>
                    )}
                  </section>

                  <section className="panel section-panel content-panel soft-enter" id="content">
                    <SectionHeading number="03" title="Class information" icon={<CalendarDays size={17} />} description="Timetables, fees and announcements" />
                    {contentQuery.isLoading ? <LoadingRows /> : contentQuery.isError ? <ErrorState message={errorText(contentQuery.error)} retry={() => void contentQuery.refetch()} /> : (
                      <>
                        <div className="content-picker-row">
                          <label className="field-label" htmlFor="content-entry">Existing information</label>
                          <div className="select-wrap"><select id="content-entry" className="input" value={activeContentKey} onChange={(event) => loadContent(event.target.value)} data-testid="select-content-entry"><option value="">Create a new entry</option>{dynamicContent.map((item) => <option value={item.key} key={item.key}>{item.title} · {item.category}</option>)}</select><ChevronDown size={15} /></div>
                        </div>
                        <form className="content-form" onSubmit={saveContent}>
                          <div className="content-form-row">
                            <div className="field-group"><label className="field-label" htmlFor="content-key">Entry key</label><input id="content-key" className="input" value={contentKey} onChange={(event) => setContentKey(event.target.value)} placeholder="e.g. 2027-theory-timetable" required maxLength={120} data-testid="input-content-key" /></div>
                            <div className="field-group"><label className="field-label" htmlFor="content-category">Category</label><div className="select-wrap"><select id="content-category" className="input" value={contentCategory} onChange={(event) => setContentCategory(event.target.value)} data-testid="select-content-category"><option value="timetable">Timetable</option><option value="pricing">Fees</option><option value="faq">FAQ</option><option value="announcement">Announcement</option><option value="general">General</option></select><ChevronDown size={15} /></div></div>
                          </div>
                          <div className="field-group"><label className="field-label" htmlFor="content-title">Title</label><input id="content-title" className="input" value={contentTitle} onChange={(event) => setContentTitle(event.target.value)} placeholder="Short title students will recognize" required maxLength={200} data-testid="input-content-title" /></div>
                          <div className="field-group"><label className="field-label" htmlFor="content-body">Information</label><textarea id="content-body" className="input content-textarea" value={contentBody} onChange={(event) => setContentBody(event.target.value)} placeholder="Write class times, fee details or an announcement…" maxLength={50000} rows={5} data-testid="input-content-body" /></div>
                          {selectedContent && <div className="updated-at">Last updated {dateLabel(selectedContent.updatedAt)}</div>}
                          {contentFeedback && <div className="feedback success-feedback" role="status"><Check size={15} />{contentFeedback}</div>}
                          {contentError && <div className="feedback error-feedback" role="alert"><CircleAlert size={15} />{contentError}</div>}
                          <div className="form-footer"><span>Content is used in student responses.</span>{activeContentKey && <button type="button" className="button button-outline" onClick={removeContent} disabled={deleteContent.isPending} data-testid="button-delete-content"><Trash2 size={15} />{deleteContent.isPending ? 'Deleting…' : 'Delete'}</button>}<button type="submit" className="button button-primary" disabled={upsertContent.isPending}>{upsertContent.isPending ? 'Saving…' : 'Save information'}<ArrowDownRight size={15} /></button></div>
                        </form>
                      </>
                    )}
                  </section>

                  <section className="panel section-panel recording-panel soft-enter" id="recordings">
                    <SectionHeading number="04" title="Recording access" icon={<Headphones size={17} />} count={recordingRequests.filter((item) => item.status === 'pending').length} description="Review requests and send a class recording" />
                    {recordingsQuery.isLoading ? <LoadingRows /> : recordingsQuery.isError ? <ErrorState message={errorText(recordingsQuery.error)} retry={() => void recordingsQuery.refetch()} /> : recordingRequests.length === 0 ? <EmptyState title="No recording requests" detail="New student requests will appear here." /> : (
                      <div className="recording-list">
                        {recordingRequests.map((request) => <article className="recording-item" key={request.id} data-testid={`recording-${request.id}`}>
                          <div className="recording-icon"><Video size={17} /></div>
                          <div className="recording-main">
                            <div className="name-line"><strong>{request.studentName || 'Student'}</strong><span className={`status-badge ${request.status}`}>{request.status}</span></div>
                            <div className="conversation-context">
                              <span className="status-badge" title="Class">{request.className && request.className !== 'Unknown' ? request.className : (request.classType || 'Class unknown')}</span>
                              <span className="status-badge" title="Requested class date">{request.requestedDate}</span>
                              <span className={`status-badge ${request.studentType.toLowerCase()}`} title="Student type">{request.studentType}</span>
                            </div>
                            {request.reason && <p className="message-preview" title="Reason">Reason: {request.reason}</p>}
                            <span className="mono-number">{request.phoneNumber}</span>
                            <div><button className="button button-small button-quiet" onClick={() => setContextTarget(request.id)} data-testid={`button-context-${request.id}`}><MessageCircle size={14} />View Chat Context</button></div>
                          </div>
                          <div className="recording-action">
                            {request.status === 'pending' ? <>
                              <input className="input" type="url" placeholder="https://zoom.us/rec/…" value={zoomInputs[request.id] ?? ''} onChange={(event) => setZoomInputs((current) => ({ ...current, [request.id]: event.target.value }))} maxLength={2048} aria-label="Zoom recording URL" data-testid={`input-zoom-${request.id}`} />
                              <button className="button button-small button-primary" onClick={() => confirmApproval(request.id)} disabled={approvingId !== null || !(zoomInputs[request.id] ?? '').trim()} data-testid={`button-approve-${request.id}`}>{approvingId === request.id ? 'Sending…' : 'Approve & Send via WhatsApp'}<Send size={14} /></button>
                              {approvalError?.id === request.id && <div className="inline-error" role="alert">{approvalError.message}</div>}
                            </> : request.zoomLink ? <a href={request.zoomLink} target="_blank" rel="noreferrer" className="button button-small button-outline">Open recording</a> : <span className="muted-label">No link attached</span>}
                          </div>
                        </article>)}
                      </div>
                    )}
                  </section>
                </div>

                {summaryQuery.data?.recentActivity && <section className="activity-footer panel">
                  <div className="activity-heading"><div><span className="eyebrow">WORKSPACE LOG</span><h3>Recent activity</h3></div><span className="activity-count">{summaryQuery.data.recentActivity.length} updates</span></div>
                  {summaryQuery.data.recentActivity.length === 0 ? <p className="small-empty">Activity will appear here as staff work through the queue.</p> : <div className="activity-list">{summaryQuery.data.recentActivity.slice(0, 5).map((event) => <div className="activity-row" key={event.id}><span className={`activity-marker ${event.kind}`} /><span>{event.description}</span><time>{dateLabel(event.at)}</time></div>)}</div>}
                </section>}
              </>
            )}

            {!authenticated && status && missingIntegrations.length === 0 && <div className="access-ready"><ShieldCheck size={16} />All services are configured. Sign in to open the workspace.</div>}
            {notice && <div className="toast-note" role="status"><Check size={16} />{notice}<button aria-label="Dismiss notification" onClick={() => setNotice('')}><X size={15} /></button></div>}
            <footer className="page-footer"><span>AL MEDIA ASSISTANT</span><span>Student support · Class operations · mediasuranga.lk</span></footer>
          </div>
        </main>
      </div>

      {contextRequest && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setContextTarget(null); }}>
        <section className="approval-modal panel" role="dialog" aria-modal="true" aria-labelledby="context-title">
          <div className="modal-top"><span className="modal-icon"><MessageCircle size={18} /></span><button className="icon-button" onClick={() => setContextTarget(null)} aria-label="Close dialog"><X size={17} /></button></div>
          <h2 id="context-title">Chat context</h2>
          <p>Last messages from {contextRequest.studentName || 'the student'} ({contextRequest.phoneNumber}) before this request.</p>
          {contextRequest.lastChatContext
            ? <div className="chat-context" data-testid="chat-context">{contextRequest.lastChatContext.split('\n').map((line, index) => <p className="message-preview" key={index}>{line}</p>)}</div>
            : <p className="small-empty">No chat context was saved for this request.</p>}
          <div className="modal-actions"><button className="button button-quiet" onClick={() => setContextTarget(null)}>Close</button></div>
        </section>
      </div>}
    </div>
  );
}

function Metric({ icon, label, value, note, tone }: { icon: ReactNode; label: string; value: number; note: string; tone: string }) {
  return <article className="metric-card panel" data-testid={`metric-${label.toLowerCase().replaceAll(' ', '-')}`}><div className={`metric-icon ${tone}`}>{icon}</div><span className="metric-label">{label}</span><strong className="metric-value">{value.toLocaleString()}</strong><span className="metric-note">{note}</span></article>;
}

function SectionHeading({ number, title, icon, count, description }: { number: string; title: string; icon: ReactNode; count?: number; description: string }) {
  return <div className="section-heading"><div className="section-heading-main"><span className="section-number">{number}</span><span className="section-icon">{icon}</span><div><h2>{title}</h2><p>{description}</p></div></div>{count !== undefined && <span className="section-count">{count}</span>}</div>;
}

function LoadingRows({ compact = false }: { compact?: boolean }) {
  return <div className={`loading-rows ${compact ? 'compact' : ''}`} aria-label="Loading records"><span /><span /><span /></div>;
}

function ErrorState({ message, retry }: { message: string; retry: () => void }) {
  return <div className="empty-state error-state"><CircleAlert size={19} /><b>Couldn’t load this section</b><p>{message}</p><button className="button button-small button-outline" onClick={retry}>Try again</button></div>;
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="empty-state"><span className="empty-icon"><Check size={18} /></span><b>{title}</b><p>{detail}</p></div>;
}

function App() {
  return <QueryClientProvider client={queryClient}><AppContent /></QueryClientProvider>;
}

export default App;
