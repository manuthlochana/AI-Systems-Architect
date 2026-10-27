import { type FormEvent, type ReactNode, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import {
  Activity, ArrowDownRight, ArrowUpRight, BookOpen, CalendarDays, Check, ChevronDown,
  CircleAlert, FileSpreadsheet, Headphones, KeyRound, LogOut, MessageCircle,
  RefreshCw, Send, Settings2, ShieldCheck, Upload, Users, Video, X,
} from 'lucide-react';
import {
  getGetAdminStatusQueryKey, getGetConversationsQueryKey, getGetDashboardSummaryQueryKey,
  getGetDeliveriesQueryKey, getGetDynamicContentQueryKey, getGetRecordingRequestsQueryKey,
  useApproveRecordingRequest, useCreateAdminSession, useDeleteAdminSession,
  useGetAdminStatus, useGetConversations, useGetDashboardSummary, useGetDeliveries,
  useGetDynamicContent, useGetRecordingRequests, useHealthCheck, useImportTuteDeliveries,
  useSetConversationMode, useUpsertDynamicContent,
} from '@workspace/api-client-react';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 20_000 } },
});
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
  const [importFeedback, setImportFeedback] = useState('');
  const [importError, setImportError] = useState('');
  const [activeContentKey, setActiveContentKey] = useState('');
  const [contentKey, setContentKey] = useState('');
  const [contentCategory, setContentCategory] = useState('general');
  const [contentTitle, setContentTitle] = useState('');
  const [contentBody, setContentBody] = useState('');
  const [contentFeedback, setContentFeedback] = useState('');
  const [contentError, setContentError] = useState('');
  const [approvalTarget, setApprovalTarget] = useState<number | null>(null);
  const [zoomLink, setZoomLink] = useState('');
  const [approvalError, setApprovalError] = useState('');
  const [notice, setNotice] = useState('');

  const statusQuery = useGetAdminStatus();
  const health = useHealthCheck();
  const status = statusQuery.data;
  const authenticated = Boolean(status?.authenticated);
  const summaryQuery = useGetDashboardSummary({ query: { enabled: authenticated, queryKey: getGetDashboardSummaryQueryKey() } });
  const conversationsQuery = useGetConversations({ mode: 'all', limit: 100 }, { query: { enabled: authenticated, queryKey: getGetConversationsQueryKey({ mode: 'all', limit: 100 }) } });
  const deliveriesQuery = useGetDeliveries({ month }, { query: { enabled: authenticated, queryKey: getGetDeliveriesQueryKey({ month }) } });
  const contentQuery = useGetDynamicContent({ query: { enabled: authenticated, queryKey: getGetDynamicContentQueryKey() } });
  const recordingsQuery = useGetRecordingRequests({ status: 'all', limit: 100 }, { query: { enabled: authenticated, queryKey: getGetRecordingRequestsQueryKey({ status: 'all', limit: 100 }) } });
  const createSession = useCreateAdminSession();
  const deleteSession = useDeleteAdminSession();
  const setMode = useSetConversationMode();
  const importDeliveries = useImportTuteDeliveries();
  const upsertContent = useUpsertDynamicContent();
  const approveRecording = useApproveRecordingRequest();

  const conversations = conversationsQuery.data ?? [];
  const deliveries = deliveriesQuery.data ?? [];
  const dynamicContent = contentQuery.data ?? [];
  const recordingRequests = recordingsQuery.data ?? [];
  const selectedContent = useMemo(() => dynamicContent.find((item) => item.key === activeContentKey), [dynamicContent, activeContentKey]);
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

  async function handleImport() {
    if (!selectedFile) return;
    setImportFeedback('');
    setImportError('');
    try {
      const fileData = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = String(reader.result ?? '');
          const separator = result.indexOf(',');
          resolve(separator >= 0 ? result.slice(separator + 1) : result);
        };
        reader.onerror = () => reject(new Error('Could not read this file.'));
        reader.readAsDataURL(selectedFile);
      });
      importDeliveries.mutate({ data: { month, fileName: selectedFile.name, fileData } }, {
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
    upsertContent.mutate({ key, data: { category: contentCategory as 'timetable' | 'pricing' | 'general', title: contentTitle.trim(), content: contentBody } }, {
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

  function confirmApproval() {
    if (approvalTarget === null || !zoomLink.trim()) return;
    setApprovalError('');
    approveRecording.mutate({ id: approvalTarget, data: { zoomLink: zoomLink.trim() } }, {
      onSuccess: () => {
        setApprovalTarget(null);
        setZoomLink('');
        setNotice('Recording link approved and sent.');
        void client.invalidateQueries({ queryKey: getGetRecordingRequestsQueryKey({ status: 'all', limit: 100 }) });
        void client.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
      },
      onError: (error) => setApprovalError(errorText(error)),
    });
  }

  const integrations = status ? [
    ['Admin key', status.adminConfigured], ['Session secret', status.sessionConfigured],
    ['Database', status.databaseConfigured], ['Gemini', status.geminiConfigured], ['YCloud', status.ycloudConfigured],
  ] as const : [];
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
                    </div>
                    <label className={`upload-zone ${selectedFile ? 'has-file' : ''}`} htmlFor="delivery-file">
                      <input id="delivery-file" type="file" accept=".csv,.xlsx,.xls,.ods" onChange={(event) => { setSelectedFile(event.target.files?.[0] ?? null); setImportFeedback(''); setImportError(''); }} data-testid="input-delivery-file" />
                      <span className="upload-icon"><Upload size={19} /></span>
                      <span className="upload-label">{selectedFile ? selectedFile.name : 'Choose a delivery spreadsheet'}</span>
                      <span className="upload-help">{selectedFile ? `${(selectedFile.size / 1024).toFixed(1)} KB · ready to sync` : 'CSV or Excel · select file to begin'}</span>
                    </label>
                    <button className="button button-primary full-button" onClick={handleImport} disabled={!selectedFile || importDeliveries.isPending}>
                      {importDeliveries.isPending ? <><RefreshCw className="spin-icon" size={15} />Processing spreadsheet…</> : <><FileSpreadsheet size={15} />Sync delivery sheet</>}
                    </button>
                    {importFeedback && <div className="feedback success-feedback" role="status"><Check size={15} />{importFeedback}</div>}
                    {importError && <div className="feedback error-feedback" role="alert"><CircleAlert size={15} />{importError}</div>}
                    <div className="table-heading"><span>RECORDS FOR {month}</span><span>{deliveriesQuery.isLoading ? '…' : deliveries.length} records</span></div>
                    {deliveriesQuery.isLoading ? <LoadingRows compact /> : deliveriesQuery.isError ? <ErrorState message={errorText(deliveriesQuery.error)} retry={() => void deliveriesQuery.refetch()} /> : deliveries.length === 0 ? <p className="small-empty">No delivery records for this month yet.</p> : (
                      <div className="delivery-table-wrap"><table className="delivery-table"><thead><tr><th>Student</th><th>Tracking</th><th>Status</th></tr></thead><tbody>
                        {deliveries.slice(0, 7).map((delivery) => <tr key={delivery.id}><td><b>{delivery.studentName || 'Student'}</b><small>{delivery.phoneNumber}</small></td><td className="font-mono-ui">{delivery.trackingNumber}</td><td><span className={`status-badge ${delivery.status.toLowerCase()}`}>{delivery.status}</span></td></tr>)}
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
                            <div className="field-group"><label className="field-label" htmlFor="content-category">Category</label><div className="select-wrap"><select id="content-category" className="input" value={contentCategory} onChange={(event) => setContentCategory(event.target.value)} data-testid="select-content-category"><option value="timetable">Timetable</option><option value="pricing">Fees</option><option value="general">Announcement</option></select><ChevronDown size={15} /></div></div>
                          </div>
                          <div className="field-group"><label className="field-label" htmlFor="content-title">Title</label><input id="content-title" className="input" value={contentTitle} onChange={(event) => setContentTitle(event.target.value)} placeholder="Short title students will recognize" required maxLength={200} data-testid="input-content-title" /></div>
                          <div className="field-group"><label className="field-label" htmlFor="content-body">Information</label><textarea id="content-body" className="input content-textarea" value={contentBody} onChange={(event) => setContentBody(event.target.value)} placeholder="Write class times, fee details or an announcement…" maxLength={50000} rows={5} data-testid="input-content-body" /></div>
                          {selectedContent && <div className="updated-at">Last updated {dateLabel(selectedContent.updatedAt)}</div>}
                          {contentFeedback && <div className="feedback success-feedback" role="status"><Check size={15} />{contentFeedback}</div>}
                          {contentError && <div className="feedback error-feedback" role="alert"><CircleAlert size={15} />{contentError}</div>}
                          <div className="form-footer"><span>Content is used in student responses.</span><button type="submit" className="button button-primary" disabled={upsertContent.isPending}>{upsertContent.isPending ? 'Saving…' : 'Save information'}<ArrowDownRight size={15} /></button></div>
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
                          <div className="recording-main"><div className="name-line"><strong>{request.studentName || 'Student'}</strong><span className={`status-badge ${request.status}`}>{request.status}</span></div><div className="conversation-context"><span>{request.batch ? `Batch ${request.batch}` : 'Batch unassigned'}</span><span className="separator-dot" />{request.classType || 'Class recording'}<span className="separator-dot" />Requested {dateLabel(request.requestedDate)}</div><span className="mono-number">{request.phoneNumber}</span></div>
                          <div className="recording-action">{request.status === 'pending' ? <button className="button button-small button-outline" onClick={() => { setApprovalTarget(request.id); setZoomLink(''); setApprovalError(''); }}>Review & send link</button> : request.zoomLink ? <a href={request.zoomLink} target="_blank" rel="noreferrer" className="button button-small button-outline">Open recording</a> : <span className="muted-label">No link attached</span>}</div>
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

      {approvalTarget !== null && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !approveRecording.isPending) setApprovalTarget(null); }}>
        <section className="approval-modal panel" role="dialog" aria-modal="true" aria-labelledby="approval-title">
          <div className="modal-top"><span className="modal-icon"><Send size={18} /></span><button className="icon-button" onClick={() => setApprovalTarget(null)} aria-label="Close dialog" disabled={approveRecording.isPending}><X size={17} /></button></div>
          <h2 id="approval-title">Approve recording request?</h2>
          <p>This will approve the student’s request and send the recording link to their WhatsApp number.</p>
          <label className="field-label" htmlFor="zoom-link">Recording link</label>
          <input id="zoom-link" className="input" type="url" required value={zoomLink} onChange={(event) => setZoomLink(event.target.value)} placeholder="https://…" maxLength={2048} data-testid="input-recording-link" />
          {approvalError && <div className="inline-error" role="alert">{approvalError}</div>}
          <div className="modal-actions"><button className="button button-quiet" onClick={() => setApprovalTarget(null)} disabled={approveRecording.isPending}>Cancel</button><button className="button button-primary" onClick={confirmApproval} disabled={approveRecording.isPending || !zoomLink.trim()}>{approveRecording.isPending ? 'Sending…' : 'Approve & send'}<Send size={15} /></button></div>
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
