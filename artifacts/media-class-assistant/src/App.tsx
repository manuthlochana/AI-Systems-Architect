import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Activity, ArrowUpRight, BookOpen, Check, ChevronDown,
  CircleAlert, Copy, FileSpreadsheet, KeyRound, LogOut, MessageCircle,
  RefreshCw, ShieldCheck, Terminal, Upload, Users, Bot,
  Sparkles, Edit3, Trash2, CheckCircle2, XCircle, Inbox, Settings,
} from 'lucide-react';
import { InboxTab } from './components/InboxTab';
import { BotSettingsTab } from './components/BotSettingsTab';
import { useDashboardEvents } from './hooks/use-dashboard-events';
import {
  getGetAdminStatusQueryKey, getGetConversationsQueryKey,
  getGetDeliveriesQueryKey, getGetSuggestedKnowledgeItemsQueryKey,
  useCreateAdminSession, useDeleteAdminSession,
  useGetAdminStatus, useGetConversations, useGetDeliveries,
  useImportTuteDeliveries, useInspectTuteDeliveryFile,
  useGetSuggestedKnowledgeItems, useUpdateSuggestedKnowledgeItem,
  useDeleteSuggestedKnowledgeItem, useApproveSuggestedKnowledgeItem,
  useRejectSuggestedKnowledgeItem,
} from '@workspace/api-client-react';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 15_000 } },
});

const DELIVERY_WAVES = ['Wave 1', 'Wave 2', 'Wave 3', 'Wave 4'] as const;
const ITEM_TYPES = ['Monthly Tute', 'Special Book'] as const;
type TabType = 'inbox' | 'handoffs' | 'knowledge' | 'suggestions' | 'deliveries' | 'settings' | 'health';

const now = new Date();
const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'An unexpected error occurred. Please try again.';
}

function dateLabel(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : date.toLocaleString('en-LK', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function AppContent() {
  const client = useQueryClient();
  const [activeTab, setActiveTab] = useState<TabType>('inbox');
  const [month, setMonth] = useState(currentMonth);
  const sanitizedMonth = useMemo(() => {
    const match = (month || '').match(/^(\d{4}-\d{2})/);
    return match ? match[1] : currentMonth;
  }, [month]);

  // Auth State
  const [loginKey, setLoginKey] = useState('');
  const [loginError, setLoginError] = useState('');
  const [notice, setNotice] = useState('');

  // Knowledge Base State
  const [kbContent, setKbContent] = useState('');
  const [kbFeedback, setKbFeedback] = useState('');
  const [kbError, setKbError] = useState('');

  // Delivery Import State
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [inspection, setInspection] = useState<{ columns: string[]; previewRows: Array<Record<string, string>>; rowCount: number } | null>(null);
  const [columnMap, setColumnMap] = useState({ phoneNumber: '', studentName: '', trackingNumber: '', address: '' });
  const [deliveryWave, setDeliveryWave] = useState<(typeof DELIVERY_WAVES)[number]>('Wave 1');
  const [itemType, setItemType] = useState<(typeof ITEM_TYPES)[number]>('Monthly Tute');
  const [importFeedback, setImportFeedback] = useState('');
  const [importError, setImportError] = useState('');

  // Logs Terminal State
  const [logsAutoRefresh, setLogsAutoRefresh] = useState(true);
  const [logsCopied, setLogsCopied] = useState(false);
  const terminalBottomRef = useRef<HTMLDivElement>(null);

  // Queries
  const statusQuery = useGetAdminStatus({ request: { credentials: 'include' } });
  const status = statusQuery.data;
  const authenticated = Boolean(status?.authenticated);
  useDashboardEvents(authenticated);

  const createSession = useCreateAdminSession({ request: { credentials: 'include' } });
  const deleteSession = useDeleteAdminSession({ request: { credentials: 'include' } });

  const conversationsQuery = useGetConversations(
    { mode: 'all', limit: 100 },
    { query: { enabled: authenticated, queryKey: getGetConversationsQueryKey({ mode: 'all', limit: 100 }) }, request: { credentials: 'include' } }
  );

  const deliveriesQuery = useGetDeliveries(
    { month: sanitizedMonth },
    { query: { enabled: authenticated, queryKey: getGetDeliveriesQueryKey({ month: sanitizedMonth }) }, request: { credentials: 'include' } }
  );

  const inspectDeliveryFile = useInspectTuteDeliveryFile({ request: { credentials: 'include' } });
  const importDeliveries = useImportTuteDeliveries({ request: { credentials: 'include' } });

  // Custom Query: Knowledge Base
  const kbQuery = useQuery({
    queryKey: ['admin-knowledge'],
    enabled: authenticated,
    queryFn: async () => {
      const res = await fetch('/api/admin/knowledge', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load knowledge base');
      const data = (await res.json()) as { content: string };
      return data.content;
    },
  });

  useEffect(() => {
    if (kbQuery.data !== undefined) {
      setKbContent(kbQuery.data);
    }
  }, [kbQuery.data]);

  // Custom Mutation: Save Knowledge Base
  const saveKbMutation = useMutation({
    mutationFn: async (content: string) => {
      const res = await fetch('/api/admin/knowledge', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to save knowledge base');
      }
      return (await res.json()) as { success: boolean; message: string };
    },
    onSuccess: (data) => {
      setKbFeedback(data.message || 'Knowledge base saved successfully!');
      setKbError('');
      void client.invalidateQueries({ queryKey: ['admin-knowledge'] });
    },
    onError: (err) => {
      setKbError(errorText(err));
      setKbFeedback('');
    },
  });

  // Custom Mutation: Switch to Bot
  const switchModeMutation = useMutation({
    mutationFn: async ({ phone, mode }: { phone: string; mode: 'bot' | 'human' }) => {
      const res = await fetch(`/api/admin/conversations/${encodeURIComponent(phone)}/mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ mode }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to switch mode');
      }
      return res.json();
    },
    onSuccess: () => {
      setNotice('Student conversation returned to automated assistant mode.');
      void client.invalidateQueries({ queryKey: getGetConversationsQueryKey({ mode: 'all', limit: 100 }) });
    },
    onError: (err) => setNotice(`Failed to switch: ${errorText(err)}`),
  });

  // Custom Query: Live Server Logs
  const logsQuery = useQuery({
    queryKey: ['admin-logs'],
    enabled: authenticated,
    refetchInterval: logsAutoRefresh ? 5_000 : false,
    queryFn: async () => {
      const res = await fetch('/api/admin/logs', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load server logs');
      const data = (await res.json()) as { logs: string[] };
      return data.logs ?? [];
    },
  });

  useEffect(() => {
    if (activeTab === 'health' && terminalBottomRef.current) {
      terminalBottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logsQuery.data, activeTab]);

  // Suggestions State
  const [suggestionStatusFilter, setSuggestionStatusFilter] = useState<'pending' | 'approved' | 'rejected' | 'all'>('pending');
  const [editingSuggestionId, setEditingSuggestionId] = useState<string | null>(null);
  const [editQuestion, setEditQuestion] = useState('');
  const [editResponse, setEditResponse] = useState('');
  const [editCategory, setEditCategory] = useState('faq');

  const suggestionsQuery = useGetSuggestedKnowledgeItems(
    { status: suggestionStatusFilter },
    {
      query: {
        enabled: authenticated,
        queryKey: getGetSuggestedKnowledgeItemsQueryKey({ status: suggestionStatusFilter }),
        refetchInterval: 10_000,
      },
      request: { credentials: 'include' },
    }
  );

  const pendingSuggestionsQuery = useGetSuggestedKnowledgeItems(
    { status: 'pending' },
    {
      query: {
        enabled: authenticated,
        queryKey: getGetSuggestedKnowledgeItemsQueryKey({ status: 'pending' }),
        refetchInterval: 10_000,
      },
      request: { credentials: 'include' },
    }
  );
  const pendingSuggestionsCount = pendingSuggestionsQuery.data?.length ?? 0;

  const approveSuggestionMutation = useApproveSuggestedKnowledgeItem({
    request: { credentials: 'include' },
    mutation: {
      onSuccess: () => {
        setNotice('Suggestion approved and added to dynamic Knowledge Base FAQ! 🌸');
        void client.invalidateQueries({ queryKey: getGetSuggestedKnowledgeItemsQueryKey() });
        void client.invalidateQueries({ queryKey: ['admin-knowledge'] });
      },
      onError: (err) => setNotice(`Failed to approve suggestion: ${errorText(err)}`),
    },
  });

  const rejectSuggestionMutation = useRejectSuggestedKnowledgeItem({
    request: { credentials: 'include' },
    mutation: {
      onSuccess: () => {
        setNotice('Suggestion marked as rejected.');
        void client.invalidateQueries({ queryKey: getGetSuggestedKnowledgeItemsQueryKey() });
      },
      onError: (err) => setNotice(`Failed to reject suggestion: ${errorText(err)}`),
    },
  });

  const deleteSuggestionMutation = useDeleteSuggestedKnowledgeItem({
    request: { credentials: 'include' },
    mutation: {
      onSuccess: () => {
        setNotice('Suggestion removed.');
        void client.invalidateQueries({ queryKey: getGetSuggestedKnowledgeItemsQueryKey() });
      },
      onError: (err) => setNotice(`Failed to delete suggestion: ${errorText(err)}`),
    },
  });

  const updateSuggestionMutation = useUpdateSuggestedKnowledgeItem({
    request: { credentials: 'include' },
    mutation: {
      onSuccess: () => {
        setNotice('Suggestion updated.');
        setEditingSuggestionId(null);
        void client.invalidateQueries({ queryKey: getGetSuggestedKnowledgeItemsQueryKey() });
      },
      onError: (err) => setNotice(`Failed to update suggestion: ${errorText(err)}`),
    },
  });

  // Derived state
  const conversations = conversationsQuery.data ?? [];
  const handoffQueue = conversations.filter((item) => item.mode === 'human');
  const attentionCount = conversations.filter((item) => item.chatStatus === 'needs_attention').length;
  const deliveries = deliveriesQuery.data ?? [];

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    setLoginError('');
    createSession.mutate(
      { data: { key: loginKey.trim() } },
      {
        onSuccess: () => {
          setLoginKey('');
          void client.invalidateQueries({ queryKey: getGetAdminStatusQueryKey() });
        },
        onError: (err) => setLoginError(errorText(err)),
      }
    );
  }

  function handleLogout() {
    deleteSession.mutate(undefined, {
      onSuccess: () => {
        void client.invalidateQueries({ queryKey: getGetAdminStatusQueryKey() });
      },
    });
  }

  async function fileAsBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result ?? '');
        const sep = result.indexOf(',');
        resolve(sep >= 0 ? result.slice(sep + 1) : result);
      };
      reader.onerror = () => reject(new Error('Failed to read file.'));
      reader.readAsDataURL(file);
    });
  }

  async function inspectFile() {
    if (!selectedFile) return;
    setImportFeedback('');
    setImportError('');
    try {
      const fileData = await fileAsBase64(selectedFile);
      inspectDeliveryFile.mutate(
        { data: { fileName: selectedFile.name, fileData } },
        {
          onSuccess: (result) => {
            setInspection(result);
            const findCol = (candidates: string[]) =>
              result.columns.find((col) =>
                candidates.some((c) => col.toLowerCase().replace(/[^a-z0-9]/g, '').includes(c))
              );
            // Auto-mapping priority: City1 -> Phone, RegNo -> Tracking, Name, Address1 -> Address
            setColumnMap({
              phoneNumber: findCol(['city1', 'phone', 'mobile', 'whatsapp', 'contact']) ?? '',
              studentName: findCol(['name', 'student']) ?? '',
              trackingNumber: findCol(['regno', 'tracking', 'track', 'waybill']) ?? '',
              address: findCol(['address1', 'address', 'postal']) ?? '',
            });
          },
          onError: (err) => setImportError(errorText(err)),
        }
      );
    } catch (err) {
      setImportError(errorText(err));
    }
  }

  async function handleImport() {
    if (!selectedFile || !inspection || Object.values(columnMap).some((v) => !v)) return;
    setImportFeedback('');
    setImportError('');
    try {
      const fileData = await fileAsBase64(selectedFile);
      importDeliveries.mutate(
        {
          data: {
            month: sanitizedMonth,
            deliveryWave,
            itemType,
            fileName: selectedFile.name,
            fileData,
            columnMap,
          },
        },
        {
          onSuccess: (result) => {
            setImportFeedback(
              `Processed ${result.processed} rows · ${result.inserted} added · ${result.updated} updated · ${result.skipped} skipped.`
            );
            setImportError(result.errors?.length ? result.errors.join(' · ') : '');
            void client.invalidateQueries({ queryKey: getGetDeliveriesQueryKey({ month: sanitizedMonth }) });
          },
          onError: (err) => setImportError(errorText(err)),
        }
      );
    } catch (err) {
      setImportError(errorText(err));
    }
  }

  function copyLogsToClipboard() {
    const text = (logsQuery.data ?? []).join('\n');
    navigator.clipboard.writeText(text).then(() => {
      setLogsCopied(true);
      setTimeout(() => setLogsCopied(false), 2000);
    });
  }

  return (
    <div className="min-h-[100dvh] bg-background text-foreground flex flex-col font-sans">
      {/* Top Navigation Bar */}
      <header className="border-b border-border/60 bg-card/60 backdrop-blur sticky top-0 z-40 px-4 lg:px-8 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary font-bold shadow-sm">
            SG
          </div>
          <div>
            <h1 className="text-base font-bold leading-tight tracking-tight">Suranga Gamage A/L Media</h1>
            <p className="text-xs text-muted-foreground">mediasuranga.lk · WhatsApp AI Platform</p>
          </div>
        </div>

        {/* Global Status Indicators & Sign Out */}
        <div className="flex items-center gap-3">
          {status && (
            <div className="hidden sm:flex items-center gap-2 px-3 py-1 bg-muted/40 rounded-full border border-border/50 text-xs">
              <span className="flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${status.databaseConfigured ? 'bg-emerald-500' : 'bg-destructive'}`} />
                DB
              </span>
              <span className="text-muted-foreground">·</span>
              <span className="flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${status.geminiConfigured ? 'bg-emerald-500' : 'bg-destructive'}`} />
                Gemini
              </span>
              <span className="text-muted-foreground">·</span>
              <span className="flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${status.ycloudConfigured ? 'bg-emerald-500' : 'bg-destructive'}`} />
                YCloud
              </span>
            </div>
          )}

          {authenticated && (
            <button
              onClick={handleLogout}
              className="px-3 py-1.5 rounded-lg border border-border/80 text-xs font-medium hover:bg-muted/60 transition-colors flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
            >
              <LogOut size={13} />
              Sign Out
            </button>
          )}
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8">
        {/* Notice Banner */}
        {notice && (
          <div className="mb-6 p-3.5 bg-primary/10 border border-primary/20 rounded-xl text-sm flex items-center justify-between animate-in fade-in">
            <span>{notice}</span>
            <button onClick={() => setNotice('')} className="text-xs font-semibold uppercase hover:underline">
              Dismiss
            </button>
          </div>
        )}

        {/* Sign In Screen */}
        {!authenticated ? (
          <div className="max-w-md mx-auto my-12 p-6 sm:p-8 bg-card border border-border rounded-2xl shadow-xl">
            <div className="text-center mb-6">
              <div className="w-12 h-12 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary mx-auto mb-3">
                <KeyRound size={22} />
              </div>
              <h2 className="text-xl font-bold tracking-tight">Staff Authentication</h2>
              <p className="text-sm text-muted-foreground mt-1">Enter your staff key to manage the WhatsApp AI system.</p>
            </div>

            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                  Admin Access Key
                </label>
                <input
                  type="password"
                  value={loginKey}
                  onChange={(e) => setLoginKey(e.target.value)}
                  placeholder="Enter staff security key"
                  className="w-full px-3.5 py-2.5 bg-background border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                  required
                />
              </div>

              {loginError && (
                <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-xl text-xs text-destructive">
                  {loginError}
                </div>
              )}

              <button
                type="submit"
                disabled={createSession.isPending || !loginKey.trim()}
                className="w-full py-2.5 bg-primary text-primary-foreground font-semibold rounded-xl text-sm hover:opacity-95 transition-opacity disabled:opacity-50 flex items-center justify-center gap-2 shadow"
              >
                {createSession.isPending ? 'Verifying…' : 'Access System'}
                <ArrowUpRight size={16} />
              </button>
            </form>

            <div className="mt-6 pt-4 border-t border-border/50 text-center text-xs text-muted-foreground flex items-center justify-center gap-1.5">
              <ShieldCheck size={14} className="text-emerald-500" />
              <span>TLS Encrypted Session · Credentials strictly verified</span>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {/* 4 Essential Tabs */}
            <div className="flex border-b border-border/80 overflow-x-auto gap-2">
              <button
                onClick={() => setActiveTab('inbox')}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-semibold border-b-2 transition-all whitespace-nowrap ${
                  activeTab === 'inbox'
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                <Inbox size={16} />
                <span>Unified Inbox</span>
                {attentionCount > 0 && (
                  <span className="px-2 py-0.5 rounded-full bg-red-500/20 text-red-500 text-xs font-bold">
                    {attentionCount}
                  </span>
                )}
              </button>

              <button
                onClick={() => setActiveTab('handoffs')}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-semibold border-b-2 transition-all whitespace-nowrap ${
                  activeTab === 'handoffs'
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                <MessageCircle size={16} />
                <span>Live Handoff Queue</span>
                {handoffQueue.length > 0 && (
                  <span className="px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-500 text-xs font-bold">
                    {handoffQueue.length}
                  </span>
                )}
              </button>

              <button
                onClick={() => setActiveTab('knowledge')}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-semibold border-b-2 transition-all whitespace-nowrap ${
                  activeTab === 'knowledge'
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                <BookOpen size={16} />
                <span>Knowledge Base Editor</span>
              </button>

              <button
                onClick={() => setActiveTab('suggestions')}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-semibold border-b-2 transition-all whitespace-nowrap ${
                  activeTab === 'suggestions'
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                <Sparkles size={16} />
                <span>AI Learning Suggestions</span>
                {pendingSuggestionsCount > 0 && (
                  <span className="px-2 py-0.5 rounded-full bg-primary/20 text-primary text-xs font-bold">
                    {pendingSuggestionsCount}
                  </span>
                )}
              </button>

              <button
                onClick={() => setActiveTab('deliveries')}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-semibold border-b-2 transition-all whitespace-nowrap ${
                  activeTab === 'deliveries'
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                <FileSpreadsheet size={16} />
                <span>Monthly Tute Delivery</span>
              </button>

              <button
                onClick={() => setActiveTab('settings')}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-semibold border-b-2 transition-all whitespace-nowrap ${
                  activeTab === 'settings'
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                <Settings size={16} />
                <span>Bot Settings</span>
              </button>

              <button
                onClick={() => setActiveTab('health')}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-semibold border-b-2 transition-all whitespace-nowrap ${
                  activeTab === 'health'
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                <Activity size={16} />
                <span>System Health & Live Logs</span>
              </button>
            </div>

            {activeTab === 'inbox' && (
              <InboxTab conversations={conversations} loading={conversationsQuery.isLoading} />
            )}

            {activeTab === 'settings' && <BotSettingsTab />}

            {/* TAB 1: Live Handoff Queue */}
            {activeTab === 'handoffs' && (
              <div className="bg-card border border-border rounded-2xl p-5 sm:p-6 shadow-sm space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-4 border-b border-border/60">
                  <div>
                    <h2 className="text-lg font-bold tracking-tight flex items-center gap-2">
                      <MessageCircle className="text-amber-500" size={19} />
                      Students Awaiting Staff Response
                    </h2>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      The WhatsApp AI bot is strictly silenced for these students until returned to assistant mode.
                    </p>
                  </div>
                  <button
                    onClick={() => void conversationsQuery.refetch()}
                    className="p-2 border border-border rounded-xl text-xs hover:bg-muted/60 transition-colors flex items-center gap-1.5 self-start sm:self-auto"
                  >
                    <RefreshCw size={13} className={conversationsQuery.isFetching ? 'animate-spin' : ''} />
                    Refresh
                  </button>
                </div>

                {conversationsQuery.isLoading ? (
                  <div className="py-12 text-center text-sm text-muted-foreground flex flex-col items-center gap-2">
                    <RefreshCw size={20} className="animate-spin text-primary" />
                    <span>Loading queue…</span>
                  </div>
                ) : handoffQueue.length === 0 ? (
                  <div className="py-12 text-center border-2 border-dashed border-border/60 rounded-2xl p-6">
                    <div className="w-10 h-10 rounded-full bg-emerald-500/10 text-emerald-500 flex items-center justify-center mx-auto mb-2">
                      <Check size={20} />
                    </div>
                    <h3 className="text-sm font-bold">All caught up!</h3>
                    <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
                      There are currently no students in manual human mode. The AI assistant is actively handling all student messages.
                    </p>
                  </div>
                ) : (
                  <div className="divide-y divide-border/60">
                    {handoffQueue.map((conv) => (
                      <div
                        key={conv.phoneNumber}
                        className="py-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 hover:bg-muted/20 px-2 rounded-xl transition-colors"
                      >
                        <div className="flex items-start gap-3">
                          <div className="w-10 h-10 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center font-bold text-primary shrink-0">
                            {(conv.studentName?.trim()?.[0] || 'S').toUpperCase()}
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-sm">{conv.studentName || 'Student'}</span>
                              <span className="font-mono text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-md">
                                {conv.phoneNumber}
                              </span>
                            </div>
                            {conv.lastMessage && (
                              <p className="text-xs text-foreground/80 mt-1 line-clamp-2 max-w-xl">
                                "{conv.lastMessage}"
                              </p>
                            )}
                            <div className="flex items-center gap-2 text-[11px] text-muted-foreground mt-1">
                              <span>Last active: {dateLabel(conv.lastMessageAt)}</span>
                              <span>·</span>
                              <span className="text-amber-500 font-medium">Bot Silenced</span>
                            </div>
                          </div>
                        </div>

                        <button
                          onClick={() => switchModeMutation.mutate({ phone: conv.phoneNumber, mode: 'bot' })}
                          disabled={switchModeMutation.isPending}
                          className="px-3.5 py-2 bg-primary text-primary-foreground text-xs font-semibold rounded-xl hover:opacity-90 transition-opacity flex items-center gap-1.5 shrink-0 shadow-sm"
                        >
                          <Bot size={14} />
                          Switch to Bot
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* TAB 2: Knowledge Base Editor */}
            {activeTab === 'knowledge' && (
              <div className="bg-card border border-border rounded-2xl p-5 sm:p-6 shadow-sm space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-4 border-b border-border/60">
                  <div>
                    <h2 className="text-lg font-bold tracking-tight flex items-center gap-2">
                      <BookOpen className="text-primary" size={19} />
                      System Knowledge Base (`knowledge-base.md`)
                    </h2>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Edits here immediately govern all student answers (timetables, night classes, fees, website rules) with zero database queries.
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => void kbQuery.refetch()}
                      className="px-3 py-1.5 border border-border rounded-xl text-xs hover:bg-muted/60 transition-colors flex items-center gap-1.5"
                    >
                      <RefreshCw size={13} className={kbQuery.isFetching ? 'animate-spin' : ''} />
                      Reload
                    </button>
                    <button
                      onClick={() => saveKbMutation.mutate(kbContent)}
                      disabled={saveKbMutation.isPending}
                      className="px-4 py-1.5 bg-primary text-primary-foreground font-semibold rounded-xl text-xs hover:opacity-90 transition-opacity flex items-center gap-1.5 shadow"
                    >
                      {saveKbMutation.isPending ? <RefreshCw size={13} className="animate-spin" /> : <Check size={13} />}
                      Save Knowledge Base
                    </button>
                  </div>
                </div>

                {kbFeedback && (
                  <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 text-emerald-500 rounded-xl text-xs flex items-center gap-2">
                    <Check size={14} />
                    <span>{kbFeedback}</span>
                  </div>
                )}
                {kbError && (
                  <div className="p-3 bg-destructive/10 border border-destructive/20 text-destructive rounded-xl text-xs flex items-center gap-2">
                    <CircleAlert size={14} />
                    <span>{kbError}</span>
                  </div>
                )}

                <div className="relative">
                  <textarea
                    value={kbContent}
                    onChange={(e) => setKbContent(e.target.value)}
                    rows={22}
                    className="w-full font-mono text-xs leading-relaxed p-4 bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/30"
                    placeholder="Loading knowledge base markdown..."
                  />
                  <div className="absolute right-3 bottom-3 text-[11px] text-muted-foreground bg-background/80 backdrop-blur px-2 py-1 rounded-md border border-border/50">
                    {kbContent.length} chars · {kbContent.split('\n').length} lines
                  </div>
                </div>
              </div>
            )}

            {/* TAB: AI Learning Suggestions */}
            {activeTab === 'suggestions' && (
              <div className="bg-card border border-border rounded-2xl p-5 sm:p-6 shadow-sm space-y-6">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-border/60">
                  <div>
                    <h2 className="text-lg font-bold tracking-tight flex items-center gap-2">
                      <Sparkles className="text-primary" size={19} />
                      AI Learning Suggestions Queue
                    </h2>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Staff responses to students in 1-on-1 chats are automatically captured here. Review, edit, and approve them into the Dynamic Knowledge Base (FAQ) for instant, safe AI learning.
                    </p>
                  </div>

                  <div className="flex items-center gap-2 flex-wrap">
                    {/* Status Filter Tabs */}
                    <div className="flex p-1 bg-muted/60 rounded-xl border border-border/50 text-xs">
                      {(['pending', 'approved', 'rejected', 'all'] as const).map((st) => (
                        <button
                          key={st}
                          onClick={() => setSuggestionStatusFilter(st)}
                          className={`px-3 py-1 rounded-lg capitalize font-medium transition-all ${
                            suggestionStatusFilter === st
                              ? 'bg-background text-foreground shadow-sm'
                              : 'text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          {st === 'pending' ? `Pending (${pendingSuggestionsCount})` : st}
                        </button>
                      ))}
                    </div>

                    <button
                      onClick={() => void suggestionsQuery.refetch()}
                      className="px-3 py-1.5 border border-border rounded-xl text-xs hover:bg-muted/60 transition-colors flex items-center gap-1.5"
                    >
                      <RefreshCw size={13} className={suggestionsQuery.isFetching ? 'animate-spin' : ''} />
                      Refresh
                    </button>
                  </div>
                </div>

                {suggestionsQuery.isLoading ? (
                  <div className="py-12 text-center text-sm text-muted-foreground flex flex-col items-center gap-2">
                    <RefreshCw className="animate-spin text-primary" size={20} />
                    <span>Loading suggested learning items...</span>
                  </div>
                ) : (suggestionsQuery.data ?? []).length === 0 ? (
                  <div className="p-12 text-center border border-dashed border-border rounded-2xl bg-muted/10 space-y-2">
                    <Sparkles className="mx-auto text-muted-foreground/60" size={32} />
                    <p className="text-sm font-semibold">No suggestions found in this view</p>
                    <p className="text-xs text-muted-foreground max-w-md mx-auto">
                      When staff members reply to students whose chats were handed off, question-and-answer pairs will be captured here for your approval.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {(suggestionsQuery.data ?? []).map((item) => {
                      const isEditing = editingSuggestionId === item.id;
                      return (
                        <div
                          key={item.id}
                          className="p-4 sm:p-5 border border-border rounded-2xl bg-background/50 hover:border-border/90 transition-all space-y-4"
                        >
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-border/40">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-mono text-xs font-bold text-foreground">
                                {item.sourceConversationId || 'WhatsApp Chat'}
                              </span>
                              <span className="text-[11px] text-muted-foreground">
                                · {dateLabel(item.createdAt)}
                              </span>
                              <span
                                className={`text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full ${
                                  item.status === 'approved'
                                    ? 'bg-emerald-500/15 text-emerald-500 border border-emerald-500/20'
                                    : item.status === 'rejected'
                                      ? 'bg-muted text-muted-foreground border border-border'
                                      : 'bg-amber-500/15 text-amber-500 border border-amber-500/20'
                                }`}
                              >
                                {item.status}
                              </span>
                              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">
                                {item.suggestedCategory}
                              </span>
                            </div>

                            <div className="flex items-center gap-2">
                              {!isEditing && item.status === 'pending' && (
                                <>
                                  <button
                                    onClick={() => {
                                      setEditingSuggestionId(item.id);
                                      setEditQuestion(item.studentQuestion);
                                      setEditResponse(item.humanStaffResponse);
                                      setEditCategory(item.suggestedCategory);
                                    }}
                                    className="px-2.5 py-1 border border-border rounded-lg text-xs hover:bg-muted/60 transition-colors flex items-center gap-1"
                                  >
                                    <Edit3 size={12} />
                                    Edit
                                  </button>
                                  <button
                                    onClick={() => approveSuggestionMutation.mutate({ id: item.id })}
                                    disabled={approveSuggestionMutation.isPending}
                                    className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold rounded-lg text-xs transition-colors flex items-center gap-1 shadow-sm"
                                  >
                                    <CheckCircle2 size={13} />
                                    Approve & Add to KB
                                  </button>
                                  <button
                                    onClick={() => rejectSuggestionMutation.mutate({ id: item.id })}
                                    disabled={rejectSuggestionMutation.isPending}
                                    className="px-2.5 py-1 border border-border text-muted-foreground hover:text-foreground rounded-lg text-xs transition-colors flex items-center gap-1"
                                  >
                                    <XCircle size={13} />
                                    Reject
                                  </button>
                                </>
                              )}
                              {!isEditing && item.status !== 'pending' && (
                                <button
                                  onClick={() => deleteSuggestionMutation.mutate({ id: item.id })}
                                  disabled={deleteSuggestionMutation.isPending}
                                  className="px-2.5 py-1 text-destructive hover:bg-destructive/10 rounded-lg text-xs transition-colors flex items-center gap-1"
                                >
                                  <Trash2 size={13} />
                                  Delete
                                </button>
                              )}
                            </div>
                          </div>

                          {isEditing ? (
                            <div className="space-y-3 pt-1">
                              <div>
                                <label className="block text-xs font-semibold text-muted-foreground mb-1">
                                  Student Question
                                </label>
                                <textarea
                                  value={editQuestion}
                                  onChange={(e) => setEditQuestion(e.target.value)}
                                  rows={2}
                                  className="w-full text-xs p-2.5 bg-background border border-border rounded-xl focus:ring-1 focus:ring-primary focus:outline-none"
                                />
                              </div>

                              <div>
                                <label className="block text-xs font-semibold text-muted-foreground mb-1">
                                  Human Staff Response (Will be committed as FAQ Answer)
                                </label>
                                <textarea
                                  value={editResponse}
                                  onChange={(e) => setEditResponse(e.target.value)}
                                  rows={3}
                                  className="w-full text-xs p-2.5 bg-background border border-border rounded-xl focus:ring-1 focus:ring-primary focus:outline-none"
                                />
                              </div>

                              <div className="flex items-center justify-between pt-2">
                                <div className="flex items-center gap-2">
                                  <label className="text-xs text-muted-foreground font-semibold">Category:</label>
                                  <select
                                    value={editCategory}
                                    onChange={(e) => setEditCategory(e.target.value)}
                                    className="text-xs p-1.5 bg-background border border-border rounded-lg"
                                  >
                                    <option value="faq">FAQ</option>
                                    <option value="timetable">Timetable</option>
                                    <option value="pricing">Pricing</option>
                                    <option value="general">General</option>
                                    <option value="announcement">Announcement</option>
                                  </select>
                                </div>

                                <div className="flex items-center gap-2">
                                  <button
                                    onClick={() => setEditingSuggestionId(null)}
                                    className="px-3 py-1.5 border border-border rounded-xl text-xs hover:bg-muted/60 transition-colors"
                                  >
                                    Cancel
                                  </button>
                                  <button
                                    onClick={() =>
                                      updateSuggestionMutation.mutate({
                                        id: item.id,
                                        data: {
                                          studentQuestion: editQuestion,
                                          humanStaffResponse: editResponse,
                                          suggestedCategory: editCategory,
                                        },
                                      })
                                    }
                                    disabled={updateSuggestionMutation.isPending}
                                    className="px-4 py-1.5 bg-primary text-primary-foreground font-semibold rounded-xl text-xs hover:opacity-90 transition-opacity"
                                  >
                                    Save Changes
                                  </button>
                                </div>
                              </div>
                            </div>
                          ) : (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                              <div className="p-3 bg-muted/30 border border-border/60 rounded-xl space-y-1">
                                <span className="font-semibold text-muted-foreground flex items-center gap-1 text-[11px]">
                                  <Users size={12} className="text-amber-500" />
                                  Student Inquiry:
                                </span>
                                <p className="text-foreground leading-relaxed whitespace-pre-wrap font-medium">
                                  {item.studentQuestion}
                                </p>
                              </div>

                              <div className="p-3 bg-primary/5 border border-primary/20 rounded-xl space-y-1">
                                <span className="font-semibold text-primary flex items-center gap-1 text-[11px]">
                                  <Bot size={12} className="text-primary" />
                                  Staff Response:
                                </span>
                                <p className="text-foreground leading-relaxed whitespace-pre-wrap font-medium">
                                  {item.humanStaffResponse}
                                </p>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* TAB 3: Monthly Tute Delivery */}
            {activeTab === 'deliveries' && (
              <div className="bg-card border border-border rounded-2xl p-5 sm:p-6 shadow-sm space-y-6">
                <div>
                  <h2 className="text-lg font-bold tracking-tight flex items-center gap-2">
                    <FileSpreadsheet className="text-emerald-500" size={19} />
                    Monthly Tute Delivery & Spreadsheet Import
                  </h2>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Import courier spreadsheets with float (.0) phone number cleanup and 9-digit key normalization.
                  </p>
                </div>

                {/* Import Controls */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 p-4 bg-muted/20 border border-border/60 rounded-xl">
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                      Delivery Month
                    </label>
                    <input
                      type="month"
                      value={sanitizedMonth}
                      maxLength={7}
                      onChange={(e) => setMonth(e.target.value.slice(0, 7) || currentMonth)}
                      className="w-full px-3 py-2 bg-background border border-border rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                      Delivery Wave
                    </label>
                    <select
                      value={deliveryWave}
                      onChange={(e) => setDeliveryWave(e.target.value as (typeof DELIVERY_WAVES)[number])}
                      className="w-full px-3 py-2 bg-background border border-border rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-primary/30"
                    >
                      {DELIVERY_WAVES.map((w) => (
                        <option key={w} value={w}>
                          {w}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                      Item Type
                    </label>
                    <select
                      value={itemType}
                      onChange={(e) => setItemType(e.target.value as (typeof ITEM_TYPES)[number])}
                      className="w-full px-3 py-2 bg-background border border-border rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-primary/30"
                    >
                      {ITEM_TYPES.map((i) => (
                        <option key={i} value={i}>
                          {i}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* File Upload Zone */}
                <div className="space-y-3">
                  <label className="block border-2 border-dashed border-border/80 hover:border-primary/50 transition-colors rounded-2xl p-6 text-center cursor-pointer bg-background/50">
                    <input
                      type="file"
                      accept=".xlsx,.xls,.csv"
                      className="hidden"
                      onChange={(e) => {
                        setSelectedFile(e.target.files?.[0] || null);
                        setInspection(null);
                        setImportFeedback('');
                        setImportError('');
                      }}
                    />
                    <Upload size={24} className="mx-auto mb-2 text-primary/80" />
                    <span className="text-sm font-semibold block">
                      {selectedFile ? selectedFile.name : 'Choose or drop a delivery spreadsheet (.xlsx, .csv)'}
                    </span>
                    <span className="text-xs text-muted-foreground mt-1 block">
                      {selectedFile ? `${(selectedFile.size / 1024).toFixed(1)} KB` : 'Prioritizes City1 (Phone), RegNo (Tracking), Name, Address1'}
                    </span>
                  </label>

                  {selectedFile && !inspection && (
                    <button
                      onClick={inspectFile}
                      disabled={inspectDeliveryFile.isPending}
                      className="w-full py-2.5 bg-primary text-primary-foreground text-xs font-semibold rounded-xl hover:opacity-95 transition-opacity flex items-center justify-center gap-2 shadow"
                    >
                      {inspectDeliveryFile.isPending ? <RefreshCw size={14} className="animate-spin" /> : <FileSpreadsheet size={14} />}
                      Inspect Spreadsheet Headers
                    </button>
                  )}
                </div>

                {/* Inspected Auto-Mapping Confirmation */}
                {inspection && (
                  <div className="p-4 bg-muted/20 border border-border rounded-xl space-y-4">
                    <div className="flex items-center justify-between text-xs font-bold border-b border-border/50 pb-2">
                      <span>Mapped Columns ({inspection.rowCount} rows detected)</span>
                      <span className="text-emerald-500 font-semibold">City1 / RegNo prioritized</span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                      {(
                        [
                          ['phoneNumber', 'Phone Number (City1)', columnMap.phoneNumber],
                          ['trackingNumber', 'Tracking No (RegNo)', columnMap.trackingNumber],
                          ['studentName', 'Student Name', columnMap.studentName],
                          ['address', 'Delivery Address (Address1)', columnMap.address],
                        ] as const
                      ).map(([field, label, value]) => (
                        <div key={field}>
                          <label className="block text-[11px] font-semibold text-muted-foreground mb-1">{label}</label>
                          <select
                            value={value}
                            onChange={(e) => setColumnMap((cur) => ({ ...cur, [field]: e.target.value }))}
                            className="w-full px-2.5 py-1.5 bg-background border border-border rounded-lg text-xs"
                          >
                            <option value="">Select column…</option>
                            {inspection.columns.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                          </select>
                        </div>
                      ))}
                    </div>

                    <button
                      onClick={handleImport}
                      disabled={importDeliveries.isPending || Object.values(columnMap).some((v) => !v)}
                      className="w-full py-2.5 bg-primary text-primary-foreground font-semibold text-xs rounded-xl hover:opacity-95 transition-opacity flex items-center justify-center gap-2 shadow"
                    >
                      {importDeliveries.isPending ? <RefreshCw size={14} className="animate-spin" /> : <Check size={14} />}
                      Import {inspection.rowCount} Delivery Records
                    </button>
                  </div>
                )}

                {importFeedback && (
                  <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 text-emerald-500 rounded-xl text-xs flex items-center gap-2">
                    <Check size={14} />
                    <span>{importFeedback}</span>
                  </div>
                )}
                {importError && (
                  <div className="p-3 bg-destructive/10 border border-destructive/20 text-destructive rounded-xl text-xs flex items-center gap-2">
                    <CircleAlert size={14} />
                    <span>{importError}</span>
                  </div>
                )}

                {/* Existing Delivery Records Table */}
                <div className="space-y-3 pt-2">
                  <div className="flex items-center justify-between text-xs font-bold text-muted-foreground uppercase tracking-wider">
                    <span>Records for {sanitizedMonth}</span>
                    <span>{deliveries.length} entries</span>
                  </div>

                  {deliveriesQuery.isLoading ? (
                    <div className="py-6 text-center text-xs text-muted-foreground">Loading deliveries…</div>
                  ) : deliveries.length === 0 ? (
                    <div className="py-8 text-center text-xs text-muted-foreground border border-border/50 rounded-xl">
                      No delivery records stored for {sanitizedMonth} yet.
                    </div>
                  ) : (
                    <div className="border border-border/60 rounded-xl overflow-hidden overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-muted/40 border-b border-border/60">
                          <tr>
                            <th className="p-2.5 font-semibold">Student</th>
                            <th className="p-2.5 font-semibold">Wave & Item</th>
                            <th className="p-2.5 font-semibold">Tracking Number</th>
                            <th className="p-2.5 font-semibold">Status</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border/40 font-mono">
                          {deliveries.slice(0, 10).map((d) => (
                            <tr key={d.id} className="hover:bg-muted/10">
                              <td className="p-2.5">
                                <span className="font-sans font-semibold block">{d.studentName || 'Student'}</span>
                                <span className="text-[11px] text-muted-foreground">{d.phoneNumber}</span>
                              </td>
                              <td className="p-2.5 font-sans">
                                <span className="block">{d.itemType}</span>
                                <span className="text-[11px] text-muted-foreground">{d.deliveryWave}</span>
                              </td>
                              <td className="p-2.5 font-semibold text-primary">{d.trackingNumber}</td>
                              <td className="p-2.5 font-sans">
                                <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-500 text-[11px] font-medium">
                                  {d.status}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {deliveries.length > 10 && (
                        <div className="p-2 text-center text-[11px] text-muted-foreground bg-muted/10 border-t border-border/40">
                          Showing 10 of {deliveries.length} records
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* TAB 4: System Health & Live Logs */}
            {activeTab === 'health' && (
              <div className="space-y-6">
                {/* Health Cards */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  <div className="p-4 bg-card border border-border rounded-2xl shadow-sm">
                    <span className="text-xs text-muted-foreground font-semibold uppercase tracking-wider block mb-1">
                      Supabase Database
                    </span>
                    <div className="flex items-center gap-2">
                      <span className={`w-2.5 h-2.5 rounded-full ${status?.databaseConfigured ? 'bg-emerald-500' : 'bg-destructive'}`} />
                      <span className="font-bold text-sm">{status?.databaseConfigured ? 'Connected (Pool Active)' : 'Disconnected'}</span>
                    </div>
                  </div>

                  <div className="p-4 bg-card border border-border rounded-2xl shadow-sm">
                    <span className="text-xs text-muted-foreground font-semibold uppercase tracking-wider block mb-1">
                      Gemini Flash Agent
                    </span>
                    <div className="flex items-center gap-2">
                      <span className={`w-2.5 h-2.5 rounded-full ${status?.geminiConfigured ? 'bg-emerald-500' : 'bg-destructive'}`} />
                      <span className="font-bold text-sm">{status?.geminiConfigured ? 'Active (Gemini 3.5 Flash)' : 'Offline'}</span>
                    </div>
                  </div>

                  <div className="p-4 bg-card border border-border rounded-2xl shadow-sm">
                    <span className="text-xs text-muted-foreground font-semibold uppercase tracking-wider block mb-1">
                      YCloud WhatsApp
                    </span>
                    <div className="flex items-center gap-2">
                      <span className={`w-2.5 h-2.5 rounded-full ${status?.ycloudConfigured ? 'bg-emerald-500' : 'bg-destructive'}`} />
                      <span className="font-bold text-sm">{status?.ycloudConfigured ? 'Connected (+94789094047)' : 'Offline'}</span>
                    </div>
                  </div>

                  <div className="p-4 bg-card border border-border rounded-2xl shadow-sm">
                    <span className="text-xs text-muted-foreground font-semibold uppercase tracking-wider block mb-1">
                      Session Security
                    </span>
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
                      <span className="font-bold text-sm">Staff Authenticated</span>
                    </div>
                  </div>
                </div>

                {/* Live Logs Terminal Card */}
                <div className="bg-card border border-border rounded-2xl p-5 sm:p-6 shadow-sm space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-border/60">
                    <div className="flex items-center gap-2">
                      <Terminal size={18} className="text-primary" />
                      <h2 className="text-base font-bold tracking-tight">Server Error & Activity Logs (Last 30 Events)</h2>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setLogsAutoRefresh((prev) => !prev)}
                        className={`px-3 py-1 rounded-lg text-xs font-semibold border transition-colors ${
                          logsAutoRefresh
                            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-500'
                            : 'bg-muted border-border text-muted-foreground'
                        }`}
                      >
                        Auto-refresh: {logsAutoRefresh ? 'ON' : 'OFF'}
                      </button>

                      <button
                        onClick={() => void logsQuery.refetch()}
                        className="px-2.5 py-1 border border-border rounded-lg text-xs hover:bg-muted/60 transition-colors flex items-center gap-1"
                      >
                        <RefreshCw size={12} className={logsQuery.isFetching ? 'animate-spin' : ''} />
                        Refresh
                      </button>

                      <button
                        onClick={copyLogsToClipboard}
                        className="px-2.5 py-1 border border-border rounded-lg text-xs hover:bg-muted/60 transition-colors flex items-center gap-1"
                      >
                        <Copy size={12} />
                        {logsCopied ? 'Copied!' : 'Copy'}
                      </button>
                    </div>
                  </div>

                  {/* Terminal Box */}
                  <div className="bg-zinc-950 text-zinc-100 rounded-xl p-4 font-mono text-xs overflow-x-auto max-h-[460px] overflow-y-auto space-y-1.5 shadow-inner">
                    {logsQuery.isLoading ? (
                      <div className="text-zinc-500 py-8 text-center">Loading live log stream…</div>
                    ) : (logsQuery.data ?? []).length === 0 ? (
                      <div className="text-zinc-500 py-8 text-center">No recent log entries available.</div>
                    ) : (
                      (logsQuery.data ?? []).map((line, idx) => {
                        const isErr = /error|fatal|fail|exception/i.test(line);
                        const isWarn = /warn/i.test(line);
                        return (
                          <div
                            key={idx}
                            className={`whitespace-pre-wrap break-all leading-relaxed ${
                              isErr ? 'text-red-400' : isWarn ? 'text-amber-300' : 'text-zinc-300'
                            }`}
                          >
                            <span className="text-zinc-600 select-none mr-2">{String(idx + 1).padStart(2, '0')}</span>
                            {line}
                          </div>
                        );
                      })
                    )}
                    <div ref={terminalBottomRef} />
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppContent />
    </QueryClientProvider>
  );
}
