import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Lock, MessageCircle, RefreshCw, Search, Send, TriangleAlert, User } from 'lucide-react';
import { getGetConversationsQueryKey, type Conversation } from '@workspace/api-client-react';
import { adminFetch } from '../lib/admin-api';

type ChatStatus = 'bot' | 'needs_attention' | 'admin_locked';

interface ThreadMessage {
  id: number;
  direction: 'inbound' | 'outbound';
  body: string;
  deliveryStatus: string;
  createdAt: string;
  sender: 'student' | 'meedi' | 'admin';
}

interface ThreadResponse {
  conversation: (Conversation & { chatStatus: ChatStatus }) | null;
  messages: ThreadMessage[];
}

const STATUS_META: Record<ChatStatus, { label: string; className: string; Icon: typeof Bot }> = {
  bot: { label: '🤖 Meedi Active', className: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30', Icon: Bot },
  needs_attention: { label: '🚨 Needs Attention', className: 'bg-red-500/15 text-red-500 border-red-500/30', Icon: TriangleAlert },
  admin_locked: { label: '🔒 Admin Locked', className: 'bg-amber-500/15 text-amber-500 border-amber-500/30', Icon: Lock },
};

export function StatusBadge({ status }: { status: ChatStatus }) {
  const meta = STATUS_META[status] ?? STATUS_META.bot;
  return (
    <span className={`px-2 py-0.5 rounded-full border text-[11px] font-semibold whitespace-nowrap ${meta.className}`}>
      {meta.label}
    </span>
  );
}

function timeLabel(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.valueOf())
    ? value
    : d.toLocaleString('en-LK', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function InboxTab({ conversations, loading }: { conversations: Conversation[]; loading: boolean }) {
  const client = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  const sorted = useMemo(() => {
    const term = search.trim().toLowerCase();
    const rank = (c: Conversation) => ((c as { chatStatus?: ChatStatus }).chatStatus === 'needs_attention' ? 0 : 1);
    return [...conversations]
      .filter((c) => !term || c.phoneNumber.includes(term) || (c.studentName ?? '').toLowerCase().includes(term))
      .sort((a, b) => rank(a) - rank(b));
  }, [conversations, search]);

  useEffect(() => {
    if (!selected && sorted.length) setSelected(sorted[0].phoneNumber);
  }, [selected, sorted]);

  const threadQuery = useQuery({
    queryKey: ['inbox-thread', selected],
    enabled: Boolean(selected),
    refetchInterval: 15_000,
    queryFn: () => adminFetch<ThreadResponse>(`/conversations/${encodeURIComponent(selected ?? '')}/messages`),
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [threadQuery.data?.messages.length, selected]);

  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['inbox-thread'] });
    void client.invalidateQueries({ queryKey: getGetConversationsQueryKey({ mode: 'all', limit: 100 }) });
  };

  const sendMutation = useMutation({
    mutationFn: (text: string) =>
      adminFetch(`/conversations/${encodeURIComponent(selected ?? '')}/send-message`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      }),
    onSuccess: () => {
      setDraft('');
      setError('');
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to send'),
  });

  const handoverMutation = useMutation({
    mutationFn: () =>
      adminFetch(`/conversations/${encodeURIComponent(selected ?? '')}/handover-to-bot`, { method: 'POST' }),
    onSuccess: () => {
      setError('');
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to hand over'),
  });

  const thread = threadQuery.data;
  const conv = thread?.conversation;
  const status: ChatStatus = conv?.chatStatus ?? 'bot';

  function submit() {
    const text = draft.trim();
    if (!text || sendMutation.isPending || !selected) return;
    sendMutation.mutate(text);
  }

  return (
    <div className="bg-card border border-border rounded-2xl shadow-sm overflow-hidden grid grid-cols-1 md:grid-cols-[320px_1fr] min-h-[620px]">
      {/* Conversation list */}
      <aside className="border-b md:border-b-0 md:border-r border-border/70 flex flex-col max-h-[620px]">
        <div className="p-3 border-b border-border/60 relative">
          <Search size={14} className="absolute left-5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or phone"
            className="w-full pl-8 pr-3 py-2 text-xs bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <div className="overflow-y-auto flex-1">
          {loading ? (
            <div className="p-6 text-center text-xs text-muted-foreground">Loading conversations…</div>
          ) : sorted.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">No conversations yet.</div>
          ) : (
            sorted.map((c) => (
              <button
                key={c.phoneNumber}
                onClick={() => setSelected(c.phoneNumber)}
                className={`w-full text-left px-4 py-3 border-b border-border/40 hover:bg-muted/40 transition-colors ${
                  selected === c.phoneNumber ? 'bg-muted/60' : ''
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-sm truncate">{c.studentName || c.phoneNumber}</span>
                  <span className="text-[10px] text-muted-foreground whitespace-nowrap">{timeLabel(c.lastMessageAt)}</span>
                </div>
                <div className="text-[11px] text-muted-foreground truncate mt-0.5">{c.lastMessage ?? '—'}</div>
                <div className="mt-1.5">
                  <StatusBadge status={(c as { chatStatus?: ChatStatus }).chatStatus ?? 'bot'} />
                </div>
              </button>
            ))
          )}
        </div>
      </aside>

      {/* Thread */}
      <section className="flex flex-col max-h-[620px]">
        {!selected ? (
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-2 p-10">
            <MessageCircle size={32} className="opacity-50" />
            <span className="text-sm">Select a conversation</span>
          </div>
        ) : (
          <>
            <header className="px-4 py-3 border-b border-border/60 flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="font-bold text-sm truncate">{conv?.studentName || selected}</div>
                <div className="text-[11px] text-muted-foreground font-mono">{selected}</div>
              </div>
              <div className="flex items-center gap-2">
                <StatusBadge status={status} />
                <button
                  onClick={() => threadQuery.refetch()}
                  className="p-1.5 border border-border rounded-lg hover:bg-muted/60"
                  title="Refresh"
                >
                  <RefreshCw size={13} className={threadQuery.isFetching ? 'animate-spin' : ''} />
                </button>
                <button
                  onClick={() => handoverMutation.mutate()}
                  disabled={status === 'bot' || handoverMutation.isPending}
                  className="px-3 py-1.5 bg-primary text-primary-foreground rounded-xl text-xs font-semibold disabled:opacity-40 flex items-center gap-1.5"
                >
                  <Bot size={13} />
                  Handover to Meedi
                </button>
              </div>
            </header>

            <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-muted/10">
              {threadQuery.isLoading && <div className="text-center text-xs text-muted-foreground">Loading…</div>}
              {(thread?.messages ?? []).map((m) => {
                const mine = m.sender !== 'student';
                return (
                  <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                    <div
                      className={`max-w-[78%] rounded-2xl px-3.5 py-2 text-sm shadow-sm border ${
                        m.sender === 'student'
                          ? 'bg-background border-border'
                          : m.sender === 'meedi'
                            ? 'bg-emerald-500/10 border-emerald-500/25'
                            : 'bg-primary/10 border-primary/25'
                      }`}
                    >
                      <div className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground mb-0.5">
                        {m.sender === 'student' ? <User size={10} /> : m.sender === 'meedi' ? <Bot size={10} /> : <MessageCircle size={10} />}
                        {m.sender === 'student' ? 'Student' : m.sender === 'meedi' ? 'Meedi' : 'Admin'}
                        <span className="font-normal">· {timeLabel(m.createdAt)}</span>
                        {m.deliveryStatus === 'closed_silently' && <span className="font-normal italic">· no reply (acknowledgement)</span>}
                      </div>
                      <div className="whitespace-pre-wrap break-words">{m.body}</div>
                    </div>
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </div>

            <footer className="p-3 border-t border-border/60 space-y-2">
              {error && <div className="text-xs text-destructive">{error}</div>}
              <div className="flex items-end gap-2">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      submit();
                    }
                  }}
                  rows={2}
                  placeholder="Reply via WhatsApp… (sending locks Meedi out of this chat; Ctrl/⌘+Enter to send)"
                  className="flex-1 text-sm p-2.5 bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                />
                <button
                  onClick={submit}
                  disabled={!draft.trim() || sendMutation.isPending}
                  className="px-4 py-2.5 bg-primary text-primary-foreground rounded-xl text-sm font-semibold disabled:opacity-40 flex items-center gap-1.5"
                >
                  {sendMutation.isPending ? <RefreshCw size={14} className="animate-spin" /> : <Send size={14} />}
                  Send
                </button>
              </div>
            </footer>
          </>
        )}
      </section>
    </div>
  );
}
