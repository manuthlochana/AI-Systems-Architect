import { type ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  ExternalLink,
  GraduationCap,
  ImagePlus,
  Lock,
  MapPin,
  MessageCircle,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  TriangleAlert,
  User,
  X,
} from 'lucide-react';
import { getGetConversationsQueryKey, type Conversation } from '@workspace/api-client-react';
import { adminFetch } from '../lib/admin-api';

type ChatStatus = 'bot' | 'needs_attention' | 'admin_locked';

interface ThreadMessage {
  id: number;
  direction: 'inbound' | 'outbound';
  body: string;
  mediaUrl?: string | null;
  deliveryStatus: string;
  createdAt: string;
  sender: 'student' | 'meedi' | 'admin';
}

interface ExtendedConversation extends Conversation {
  chatStatus: ChatStatus;
  gender?: 'male' | 'female' | 'unknown';
  examYear?: number | string | null;
  hometownDistrict?: string | null;
  otherSubjects?: string | null;
  classType?: 'online' | 'physical' | 'undecided';
  physicalLocation?: 'matara_sipyana' | 'tangalle_maarga' | 'galle_ics' | null;
  onboardingStatus?: 'new_lead' | 'profiling' | 'payment_pending' | 'onboarded';
}

interface ThreadResponse {
  conversation: ExtendedConversation | null;
  messages: ThreadMessage[];
}

const IMAGE_PREFIX_REGEX = /^\[IMAGE:(https?:\/\/[^\]]+|\/api\/[^\]]+)\](?:\n([\s\S]*))?$/;

function extractDisplayMessage(m: ThreadMessage): { mediaUrl: string | null; text: string } {
  if (m.mediaUrl) {
    return { mediaUrl: m.mediaUrl, text: m.body };
  }
  const match = (m.body || '').match(IMAGE_PREFIX_REGEX);
  if (match) {
    return { mediaUrl: match[1] ?? null, text: (match[2] ?? '').trim() };
  }
  return { mediaUrl: null, text: m.body };
}

function formatSidebarPreview(raw: string | null | undefined): string {
  if (!raw) return '—';
  const match = raw.match(IMAGE_PREFIX_REGEX);
  if (match) {
    const caption = (match[2] ?? '').trim();
    return caption ? `📷 ${caption}` : '📷 Photo attachment';
  }
  return raw;
}

const STATUS_META: Record<ChatStatus, { label: string; className: string; Icon: typeof Bot }> = {
  bot: { label: '🤖 Meedi Active', className: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30', Icon: Bot },
  needs_attention: { label: '🚨 Needs Attention', className: 'bg-red-500/15 text-red-500 border-red-500/30', Icon: TriangleAlert },
  admin_locked: { label: '🔒 Admin Locked', className: 'bg-amber-500/15 text-amber-500 border-amber-500/30', Icon: Lock },
};

const ONBOARDING_BADGE: Record<string, { label: string; className: string }> = {
  onboarded: { label: '✓ Enrolled Student', className: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30' },
  payment_pending: { label: '💳 Payment Pending', className: 'bg-amber-500/15 text-amber-500 border-amber-500/30' },
  profiling: { label: '🌱 Profiling Lead', className: 'bg-sky-500/15 text-sky-500 border-sky-500/30' },
  new_lead: { label: '✨ New Lead', className: 'bg-purple-500/15 text-purple-500 border-purple-500/30' },
};

const LOCATION_LABELS: Record<string, string> = {
  matara_sipyana: 'Matara (Sipyana)',
  tangalle_maarga: 'Tangalle (Maarga)',
  galle_ics: 'Galle (ICS)',
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
  const [attachedImage, setAttachedImage] = useState<{
    dataUrl: string;
    name: string;
    mimeType: string;
  } | null>(null);
  const [error, setError] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    mutationFn: (payload: {
      text: string;
      imageData?: string;
      imageName?: string;
      imageMimeType?: string;
    }) =>
      adminFetch(`/conversations/${encodeURIComponent(selected ?? '')}/send-message`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      setDraft('');
      setAttachedImage(null);
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

  const resetProfileMutation = useMutation({
    mutationFn: () =>
      adminFetch(`/conversations/${encodeURIComponent(selected ?? '')}/reset-profile`, { method: 'POST' }),
    onSuccess: () => {
      setError('');
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to reset student profile'),
  });

  const thread = threadQuery.data;
  const conv = thread?.conversation;
  const status: ChatStatus = conv?.chatStatus ?? 'bot';

  function handleImageSelect(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('Please select a valid image file (JPG, PNG, WEBP).');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError('Image must be smaller than 10 MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? '');
      if (dataUrl) {
        setAttachedImage({
          dataUrl,
          name: file.name,
          mimeType: file.type || 'image/jpeg',
        });
        setError('');
      }
    };
    reader.onerror = () => setError('Could not read the selected image.');
    reader.readAsDataURL(file);
  }

  function submit() {
    const text = draft.trim();
    if ((!text && !attachedImage) || sendMutation.isPending || !selected) return;
    sendMutation.mutate({
      text,
      ...(attachedImage
        ? {
            imageData: attachedImage.dataUrl,
            imageName: attachedImage.name,
            imageMimeType: attachedImage.mimeType,
          }
        : {}),
    });
  }

  const onboardingMeta = conv?.onboardingStatus ? ONBOARDING_BADGE[conv.onboardingStatus] : null;

  return (
    <div className="bg-card border border-border rounded-2xl shadow-sm overflow-hidden grid grid-cols-1 md:grid-cols-[320px_1fr] min-h-[640px]">
      {/* Conversation list */}
      <aside className="border-b md:border-b-0 md:border-r border-border/70 flex flex-col max-h-[640px]">
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
                <div className="text-[11px] text-muted-foreground truncate mt-0.5">
                  {formatSidebarPreview(c.lastMessage)}
                </div>
                <div className="mt-1.5">
                  <StatusBadge status={(c as { chatStatus?: ChatStatus }).chatStatus ?? 'bot'} />
                </div>
              </button>
            ))
          )}
        </div>
      </aside>

      {/* Thread */}
      <section className="flex flex-col max-h-[640px]">
        {!selected ? (
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-2 p-10">
            <MessageCircle size={32} className="opacity-50" />
            <span className="text-sm">Select a conversation</span>
          </div>
        ) : (
          <>
            <header className="px-4 py-3 border-b border-border/60 flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-sm truncate">{conv?.studentName || selected}</span>
                  <span className="text-[11px] text-muted-foreground font-mono">{selected}</span>
                  {onboardingMeta && (
                    <span className={`px-2 py-0.5 rounded-full border text-[10px] font-semibold ${onboardingMeta.className}`}>
                      {onboardingMeta.label}
                    </span>
                  )}
                </div>

                {/* Discovered Student Profile Memory Pills */}
                {(conv?.examYear || conv?.hometownDistrict || (conv?.classType && conv.classType !== 'undecided') || conv?.otherSubjects) && (
                  <div className="flex items-center gap-1.5 flex-wrap text-[11px] text-muted-foreground">
                    {conv.examYear && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-muted/70 border border-border/60 font-medium text-foreground">
                        <GraduationCap size={11} className="text-primary" />
                        {conv.examYear} A/L
                      </span>
                    )}
                    {conv.hometownDistrict && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-muted/70 border border-border/60">
                        <MapPin size={11} className="text-emerald-500" />
                        {conv.hometownDistrict}
                      </span>
                    )}
                    {conv.classType && conv.classType !== 'undecided' && (
                      <span className="px-2 py-0.5 rounded-md bg-muted/70 border border-border/60 capitalize">
                        {conv.physicalLocation
                          ? LOCATION_LABELS[conv.physicalLocation] ?? conv.classType
                          : `${conv.classType} Class`}
                      </span>
                    )}
                    {conv.otherSubjects && (
                      <span className="px-2 py-0.5 rounded-md bg-muted/70 border border-border/60">
                        Subjects: {conv.otherSubjects}
                      </span>
                    )}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <StatusBadge status={status} />
                <button
                  onClick={() => threadQuery.refetch()}
                  className="p-1.5 border border-border rounded-lg hover:bg-muted/60"
                  title="Refresh"
                >
                  <RefreshCw size={13} className={threadQuery.isFetching ? 'animate-spin' : ''} />
                </button>
                <button
                  onClick={() => resetProfileMutation.mutate()}
                  disabled={resetProfileMutation.isPending}
                  className="px-2.5 py-1.5 border border-border bg-muted/40 hover:bg-muted text-foreground rounded-xl text-xs font-semibold disabled:opacity-40 flex items-center gap-1.5 transition-colors"
                  title="Reset student to new_lead and clear all profiling memory for testing"
                >
                  <RotateCcw size={12} className={resetProfileMutation.isPending ? 'animate-spin' : ''} />
                  Reset Student Profile
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
                const { mediaUrl, text } = extractDisplayMessage(m);
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
                      <div className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground mb-1">
                        {m.sender === 'student' ? <User size={10} /> : m.sender === 'meedi' ? <Bot size={10} /> : <MessageCircle size={10} />}
                        {m.sender === 'student' ? 'Student' : m.sender === 'meedi' ? 'Meedi' : 'Admin'}
                        <span className="font-normal">· {timeLabel(m.createdAt)}</span>
                        {m.deliveryStatus === 'closed_silently' && <span className="font-normal italic">· no reply (acknowledgement)</span>}
                      </div>

                      {mediaUrl && (
                        <div className="mb-1.5">
                          <a
                            href={mediaUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="group relative block overflow-hidden rounded-xl border border-border/60 bg-muted/30 max-w-xs"
                          >
                            <img
                              src={mediaUrl}
                              alt={text || 'WhatsApp image attachment'}
                              loading="lazy"
                              className="max-h-64 w-auto object-contain rounded-xl transition-transform group-hover:scale-[1.01]"
                            />
                            <span className="absolute bottom-1.5 right-1.5 px-2 py-0.5 rounded-md bg-black/65 text-white text-[10px] flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <ExternalLink size={10} />
                              Open full image
                            </span>
                          </a>
                        </div>
                      )}

                      {text && <div className="whitespace-pre-wrap break-words">{text}</div>}
                    </div>
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </div>

            <footer className="p-3 border-t border-border/60 space-y-2">
              {error && <div className="text-xs text-destructive">{error}</div>}

              {attachedImage && (
                <div className="flex items-center gap-3 p-2 bg-muted/40 border border-border rounded-xl">
                  <img
                    src={attachedImage.dataUrl}
                    alt={attachedImage.name}
                    className="w-12 h-12 object-cover rounded-lg border border-border"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold truncate">{attachedImage.name}</div>
                    <div className="text-[11px] text-muted-foreground">Ready to send via WhatsApp</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setAttachedImage(null)}
                    className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground"
                    title="Remove image"
                  >
                    <X size={14} />
                  </button>
                </div>
              )}

              <div className="flex items-end gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  className="hidden"
                  onChange={handleImageSelect}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={sendMutation.isPending}
                  className="p-2.5 border border-border rounded-xl hover:bg-muted/60 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
                  title="Attach image to send on WhatsApp"
                >
                  <ImagePlus size={16} />
                </button>

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
                  placeholder={
                    attachedImage
                      ? 'Add an optional caption for this photo… (Ctrl/⌘+Enter to send)'
                      : 'Reply via WhatsApp… (sending locks Meedi out of this chat; Ctrl/⌘+Enter to send)'
                  }
                  className="flex-1 text-sm p-2.5 bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                />
                <button
                  onClick={submit}
                  disabled={(!draft.trim() && !attachedImage) || sendMutation.isPending}
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
