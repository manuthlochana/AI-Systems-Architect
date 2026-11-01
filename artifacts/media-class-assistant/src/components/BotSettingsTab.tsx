import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Check, CircleAlert, RefreshCw, RotateCcw } from 'lucide-react';
import { adminFetch } from '../lib/admin-api';

interface BotSettingsResponse {
  systemPrompt: string;
  enabled: boolean;
  temperature: number;
  handoverTimeoutHours: number;
  updatedAt: string;
  defaultPrompt: string;
}

export function BotSettingsTab() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['bot-settings'],
    queryFn: () => adminFetch<BotSettingsResponse>('/admin/bot-settings'),
  });

  const [prompt, setPrompt] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [temperature, setTemperature] = useState(0.4);
  const [timeout, setTimeoutHours] = useState(4);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const data = query.data;
    if (!data) return;
    setPrompt(data.systemPrompt.trim() ? data.systemPrompt : data.defaultPrompt);
    setEnabled(data.enabled);
    setTemperature(data.temperature);
    setTimeoutHours(data.handoverTimeoutHours);
  }, [query.data]);

  const save = useMutation({
    mutationFn: (body: Partial<BotSettingsResponse>) =>
      adminFetch<BotSettingsResponse>('/admin/bot-settings', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      setFeedback('Saved. Meedi uses the new settings from the very next reply.');
      setError('');
      void client.invalidateQueries({ queryKey: ['bot-settings'] });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to save');
      setFeedback('');
    },
  });

  const defaultPrompt = query.data?.defaultPrompt ?? '';

  return (
    <div className="bg-card border border-border rounded-2xl p-5 sm:p-6 shadow-sm space-y-5">
      <div className="pb-4 border-b border-border/60">
        <h2 className="text-lg font-bold tracking-tight flex items-center gap-2">
          <Bot className="text-primary" size={19} />
          Meedi Bot Settings
        </h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Live persona and behaviour. Changes apply to the next reply without redeploying.
        </p>
      </div>

      {feedback && (
        <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 text-emerald-500 rounded-xl text-xs flex items-center gap-2">
          <Check size={14} /> {feedback}
        </div>
      )}
      {error && (
        <div className="p-3 bg-destructive/10 border border-destructive/20 text-destructive rounded-xl text-xs flex items-center gap-2">
          <CircleAlert size={14} /> {error}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <label className="flex items-center justify-between gap-3 p-3 border border-border rounded-xl cursor-pointer">
          <span>
            <span className="block text-sm font-semibold">Meedi {enabled ? 'On' : 'Off'}</span>
            <span className="block text-[11px] text-muted-foreground">Global switch for automatic replies</span>
          </span>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="w-5 h-5 accent-primary" />
        </label>

        <label className="block p-3 border border-border rounded-xl">
          <span className="block text-sm font-semibold">Human handover timeout (hours)</span>
          <input
            type="number"
            min={1}
            max={168}
            value={timeout}
            onChange={(e) => setTimeoutHours(Number(e.target.value))}
            className="mt-1.5 w-full text-sm p-2 bg-background border border-border rounded-lg"
          />
          <span className="block text-[11px] text-muted-foreground mt-1">Rolling lock after the last admin message (default 4)</span>
        </label>

        <label className="block p-3 border border-border rounded-xl">
          <span className="block text-sm font-semibold">Temperature: {temperature.toFixed(2)}</span>
          <input
            type="range"
            min={0}
            max={1.5}
            step={0.05}
            value={temperature}
            onChange={(e) => setTemperature(Number(e.target.value))}
            className="mt-2 w-full accent-primary"
          />
        </label>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Live System Prompt &amp; Guidelines
          </label>
          <button
            onClick={() => setPrompt(defaultPrompt)}
            className="text-xs px-2.5 py-1 border border-border rounded-lg hover:bg-muted/60 flex items-center gap-1"
          >
            <RotateCcw size={12} /> Reset to default
          </button>
        </div>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={22}
          className="w-full font-mono text-xs leading-relaxed p-4 bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/30"
          placeholder="Loading prompt…"
        />
        <p className="text-[11px] text-muted-foreground mt-1">
          The Knowledge Base and live announcements are appended automatically; this text defines identity, tone and guardrails.
        </p>
      </div>

      <div className="flex justify-end">
        <button
          onClick={() =>
            save.mutate({
              // Saving text identical to the default stores an empty prompt so future default upgrades still apply.
              systemPrompt: prompt.trim() === defaultPrompt.trim() ? '' : prompt,
              enabled,
              temperature,
              handoverTimeoutHours: timeout,
            })
          }
          disabled={save.isPending || query.isLoading}
          className="px-5 py-2 bg-primary text-primary-foreground font-semibold rounded-xl text-sm flex items-center gap-2 disabled:opacity-50"
        >
          {save.isPending ? <RefreshCw size={14} className="animate-spin" /> : <Check size={14} />}
          Save settings
        </button>
      </div>
    </div>
  );
}
