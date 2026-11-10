import { type FormEvent, useEffect, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Activity, ArrowUpRight, BookOpen, Check,
  CircleAlert, Copy, KeyRound, LogOut, MessageCircle,
  RefreshCw, ShieldCheck, Terminal, Users, Bot,
  Sparkles, Edit3, Trash2, CheckCircle2, XCircle, Inbox, BrainCircuit,
} from 'lucide-react';
import { InboxTab } from './components/InboxTab';
import { BotSettingsTab } from './components/BotSettingsTab';
import { useDashboardEvents } from './hooks/use-dashboard-events';
import {
  getGetAdminStatusQueryKey,
  getGetConversationsQueryKey,
  getGetSuggestedKnowledgeItemsQueryKey,
  useCreateAdminSession,
  useDeleteAdminSession,
  useGetAdminStatus,
  useGetConversations,
  useGetSuggestedKnowledgeItems,
  useUpdateSuggestedKnowledgeItem,
  useDeleteSuggestedKnowledgeItem,
  useApproveSuggestedKnowledgeItem,
  useRejectSuggestedKnowledgeItem,
} from '@workspace/api-client-react';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 15_000 } },
});

type TabType = 'inbox' | 'knowledge' | 'insights';

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

  // Auth State
  const [loginKey, setLoginKey] = useState('');
  const [loginError, setLoginError] = useState('');
  const [notice, setNotice] = useState('');

  // Knowledge Base State
  const [kbContent, setKbContent] = useState('');
  const [kbFeedback, setKbFeedback] = useState('');
  const [kbError, setKbError] = useState('');

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
    {
      query: {
        enabled: authenticated,
        queryKey: getGetConversationsQueryKey({ mode: 'all', limit: 100 }),
      },
      request: { credentials: 'include' },
    }
  );

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
    enabled: authenticated && activeTab === 'knowledge',
    refetchInterval: logsAutoRefresh ? 5_000 : false,
    queryFn: async () => {
      const res = await fetch('/api/admin/logs', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load server logs');
      const data = (await res.json()) as { logs: string[] };
      return data.logs ?? [];
    },
  });

  // Autonomous Insights State
  const [suggestionStatusFilter, setSuggestionStatusFilter] = useState<'all' | 'approved' | 'pending' | 'rejected'>('all');
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
        setNotice('Insight approved and promoted to Active Agent Memory! 🌸');
        void client.invalidateQueries({ queryKey: getGetSuggestedKnowledgeItemsQueryKey() });
        void client.invalidateQueries({ queryKey: ['admin-knowledge'] });
      },
      onError: (err) => setNotice(`Failed to approve insight: ${errorText(err)}`),
    },
  });

  const rejectSuggestionMutation = useRejectSuggestedKnowledgeItem({
    request: { credentials: 'include' },
    mutation: {
      onSuccess: () => {
        setNotice('Insight marked as rejected.');
        void client.invalidateQueries({ queryKey: getGetSuggestedKnowledgeItemsQueryKey() });
      },
      onError: (err) => setNotice(`Failed to reject insight: ${errorText(err)}`),
    },
  });

  const deleteSuggestionMutation = useDeleteSuggestedKnowledgeItem({
    request: { credentials: 'include' },
    mutation: {
      onSuccess: () => {
        setNotice('Insight removed.');
        void client.invalidateQueries({ queryKey: getGetSuggestedKnowledgeItemsQueryKey() });
      },
      onError: (err) => setNotice(`Failed to delete insight: ${errorText(err)}`),
    },
  });

  const updateSuggestionMutation = useUpdateSuggestedKnowledgeItem({
    request: { credentials: 'include' },
    mutation: {
      onSuccess: () => {
        setNotice('Insight updated.');
        setEditingSuggestionId(null);
        void client.invalidateQueries({ queryKey: getGetSuggestedKnowledgeItemsQueryKey() });
      },
      onError: (err) => setNotice(`Failed to update insight: ${errorText(err)}`),
    },
  });

  // Derived state
  const conversations = conversationsQuery.data ?? [];
  const handoffQueue = conversations.filter((item) => item.mode === 'human');
  const attentionCount = conversations.filter((item) => item.chatStatus === 'needs_attention').length;

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
            <p className="text-xs text-muted-foreground">mediasuranga.lk · Autonomous WhatsApp Coordinator</p>
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
            {/* Streamlined 3-Pillar Navigation */}
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
                <span>Inbox (Live Chats)</span>
                {attentionCount > 0 && (
                  <span className="px-2 py-0.5 rounded-full bg-red-500/20 text-red-500 text-xs font-bold">
                    {attentionCount}
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
                <span>Knowledge Base</span>
              </button>

              <button
                onClick={() => setActiveTab('insights')}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-semibold border-b-2 transition-all whitespace-nowrap ${
                  activeTab === 'insights'
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                <BrainCircuit size={16} />
                <span>AI Autonomous Insights</span>
                {pendingSuggestionsCount > 0 && (
                  <span className="px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-500 text-xs font-bold">
                    {pendingSuggestionsCount} Review
                  </span>
                )}
              </button>
            </div>

            {/* TAB 1: INBOX (LIVE CHATS) */}
            {activeTab === 'inbox' && (
              <div className="space-y-4">
                {handoffQueue.length > 0 && (
                  <div className="bg-amber-500/5 border border-amber-500/25 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5 text-xs">
                      <MessageCircle size={16} className="text-amber-500 shrink-0" />
                      <span>
                        <strong>{handoffQueue.length} conversation(s)</strong> currently in Human Mode (Meedi silenced). Select any chat below or click <strong>Handover to Meedi</strong> when resolved.
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {handoffQueue.slice(0, 3).map((conv) => (
                        <button
                          key={conv.phoneNumber}
                          onClick={() => switchModeMutation.mutate({ phone: conv.phoneNumber, mode: 'bot' })}
                          disabled={switchModeMutation.isPending}
                          className="px-2.5 py-1 bg-background border border-border rounded-lg text-[11px] font-semibold hover:bg-muted transition-colors flex items-center gap-1"
                          title={`Release ${conv.studentName || conv.phoneNumber} to Meedi`}
                        >
                          <Bot size={11} className="text-primary" />
                          Release {conv.studentName || conv.phoneNumber}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <InboxTab conversations={conversations} loading={conversationsQuery.isLoading} />
              </div>
            )}

            {/* TAB 2: KNOWLEDGE BASE & BOT CONFIGURATION */}
            {activeTab === 'knowledge' && (
              <div className="space-y-6">
                <div className="bg-card border border-border rounded-2xl p-5 sm:p-6 shadow-sm space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-4 border-b border-border/60">
                    <div>
                      <h2 className="text-lg font-bold tracking-tight flex items-center gap-2">
                        <BookOpen className="text-primary" size={19} />
                        System Knowledge Base (`knowledge-base.md`)
                      </h2>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Edits here immediately govern all student answers (timetables, night classes, fees, website rules, and tute tracking links).
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
                      rows={20}
                      className="w-full font-mono text-xs leading-relaxed p-4 bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/30"
                      placeholder="Loading knowledge base markdown..."
                    />
                    <div className="absolute right-3 bottom-3 text-[11px] text-muted-foreground bg-background/80 backdrop-blur px-2 py-1 rounded-md border border-border/50">
                      {kbContent.length} chars · {kbContent.split('\n').length} lines
                    </div>
                  </div>
                </div>

                {/* Bot Settings & Persona Controls */}
                <BotSettingsTab />

                {/* Live Server Logs Terminal Card */}
                <div className="bg-card border border-border rounded-2xl p-5 sm:p-6 shadow-sm space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-border/60">
                    <div className="flex items-center gap-2">
                      <Terminal size={18} className="text-primary" />
                      <h2 className="text-base font-bold tracking-tight">System Health & Live Logs (Last 30 Events)</h2>
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

                  <div className="bg-zinc-950 text-zinc-100 rounded-xl p-4 font-mono text-xs overflow-x-auto max-h-[360px] overflow-y-auto space-y-1.5 shadow-inner">
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

            {/* TAB 3: AI AUTONOMOUS INSIGHTS (HERMES / MEMGPT ZERO-CLICK MEMORY) */}
            {activeTab === 'insights' && (
              <div className="bg-card border border-border rounded-2xl p-5 sm:p-6 shadow-sm space-y-6">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-border/60">
                  <div>
                    <h2 className="text-lg font-bold tracking-tight flex items-center gap-2">
                      <BrainCircuit className="text-primary" size={19} />
                      Autonomous Self-Distillation & Memory Engine
                    </h2>
                    <p className="text-xs text-muted-foreground mt-0.5 max-w-2xl">
                      Background worker automatically scans resolved human-staff chats after 30 minutes of inactivity.
                      High-confidence PII-free insights (<strong>Confidence ≥ 88%</strong>) are <strong>auto-promoted directly into Meedi&apos;s active prompt memory</strong> with zero human clicking. Ambiguous insights (&lt; 88%) are staged below for audit.
                    </p>
                  </div>

                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="flex p-1 bg-muted/60 rounded-xl border border-border/50 text-xs">
                      {(
                        [
                          ['all', 'All Insights'],
                          ['approved', 'Auto-Promoted / Active'],
                          ['pending', `Staged Review (${pendingSuggestionsCount})`],
                          ['rejected', 'Rejected'],
                        ] as const
                      ).map(([st, label]) => (
                        <button
                          key={st}
                          onClick={() => setSuggestionStatusFilter(st)}
                          className={`px-3 py-1 rounded-lg font-medium transition-all ${
                            suggestionStatusFilter === st
                              ? 'bg-background text-foreground shadow-sm'
                              : 'text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          {label}
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

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="p-3.5 rounded-xl bg-emerald-500/5 border border-emerald-500/20 flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-emerald-500/15 text-emerald-500 flex items-center justify-center shrink-0">
                      <Activity size={16} />
                    </div>
                    <div>
                      <div className="text-xs font-bold">Zero-Click Background Loop</div>
                      <div className="text-[11px] text-muted-foreground">Scans every 2m after 30m chat inactivity</div>
                    </div>
                  </div>
                  <div className="p-3.5 rounded-xl bg-primary/5 border border-primary/20 flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-primary/15 text-primary flex items-center justify-center shrink-0">
                      <Sparkles size={16} />
                    </div>
                    <div>
                      <div className="text-xs font-bold">Auto-Promotion Threshold ≥ 88%</div>
                      <div className="text-[11px] text-muted-foreground">Injected into buildSystemInstruction live</div>
                    </div>
                  </div>
                  <div className="p-3.5 rounded-xl bg-amber-500/5 border border-amber-500/20 flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-amber-500/15 text-amber-500 flex items-center justify-center shrink-0">
                      <ShieldCheck size={16} />
                    </div>
                    <div>
                      <div className="text-xs font-bold">100% PII Scrubbed</div>
                      <div className="text-[11px] text-muted-foreground">Phones, NICs & personal one-offs stripped</div>
                    </div>
                  </div>
                </div>

                {suggestionsQuery.isLoading ? (
                  <div className="py-12 text-center text-sm text-muted-foreground flex flex-col items-center gap-2">
                    <RefreshCw className="animate-spin text-primary" size={20} />
                    <span>Loading autonomous memory insights...</span>
                  </div>
                ) : (suggestionsQuery.data ?? []).length === 0 ? (
                  <div className="p-12 text-center border border-dashed border-border rounded-2xl bg-muted/10 space-y-2">
                    <BrainCircuit className="mx-auto text-muted-foreground/60" size={32} />
                    <p className="text-sm font-semibold">No autonomous insights in this filter yet</p>
                    <p className="text-xs text-muted-foreground max-w-md mx-auto">
                      As staff resolve student inquiries, the background worker automatically synthesizes reusable class rules and promotes high-confidence insights (≥ 88%) directly into active memory.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {(suggestionsQuery.data ?? []).map((item) => {
                      const isEditing = editingSuggestionId === item.id;
                      const confPct = typeof item.confidence === 'number' ? Math.round(item.confidence * 100) : 90;
                      const isAutoPromoted = item.status === 'approved' && confPct >= 88;
                      return (
                        <div
                          key={item.id}
                          className="p-4 sm:p-5 border border-border rounded-2xl bg-background/50 hover:border-border/90 transition-all space-y-4"
                        >
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-border/40">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-mono text-xs font-bold text-foreground">
                                {item.source === 'autonomous_reflection'
                                  ? '🧬 Autonomous Reflection'
                                  : item.sourceConversationId || 'Staff Resolution'}
                              </span>
                              <span className="text-[11px] text-muted-foreground">
                                · {dateLabel(item.createdAt)}
                              </span>
                              <span
                                className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                                  confPct >= 88
                                    ? 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30'
                                    : 'bg-amber-500/15 text-amber-500 border-amber-500/30'
                                }`}
                              >
                                Confidence {confPct}%
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
                                {isAutoPromoted
                                  ? '⚡ Auto-Promoted to Active Memory'
                                  : item.status === 'approved'
                                    ? '✓ Active in Memory'
                                    : item.status === 'pending'
                                      ? '⏳ Staged for Audit (<88%)'
                                      : 'Rejected'}
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
                                    Promote to Memory
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
                                  Synthesized Question / Topic
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
                                  Synthesized Rule / Policy Answer
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
                                  Generalized Student Scenario:
                                </span>
                                <p className="text-foreground leading-relaxed whitespace-pre-wrap font-medium">
                                  {item.studentQuestion}
                                </p>
                              </div>

                              <div className="p-3 bg-primary/5 border border-primary/20 rounded-xl space-y-1">
                                <span className="font-semibold text-primary flex items-center gap-1 text-[11px]">
                                  <Bot size={12} className="text-primary" />
                                  Synthesized Policy / Answer:
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
