/**
 * apps/web/src/app/(app)/dashboard/page.tsx
 * PVOT — Executive Command Center · Dashboard
 *
 * PRODUCTION-GRADE REWRITE — all previous patches consolidated cleanly.
 *
 * Key fixes:
 *  1. OAuth popup: useConnectAccount hook — never double-exchanges the code
 *  2. Auto-refresh: postMessage + storage event listeners — lane appears the
 *     moment the popup closes, no manual refresh required
 *  3. Google profile photos: next/image with lh3.googleusercontent.com domain
 *  4. viewDate + laneLabel + laneEmail passed to GlassLane
 *  5. Reality sync defensive fallback for old store versions
 *  6. Zero syntax errors — written clean, not patched
 */

'use client';

import {
  useEffect, useCallback, useState, useRef, useMemo,
} from 'react';
import Image from 'next/image';
import {
  Plus, Zap, Globe, X, FileText, AlertTriangle, Clock,
  ArrowLeftRight, ChevronDown, RotateCcw, ChevronUp, Search, Settings,
} from 'lucide-react';
import { useAuthStore }          from '@pvot/core/stores';
import { usePVOTStore }          from '@pvot/core/stores/pvotStore';
import { useLaneQuery }          from '@pvot/query/useLaneQuery';
import { useConnectAccount }     from '@pvot/core/auth/useConnectAccount';
import {
  GlassLane,
  TimeRuler,
  HOUR_HEIGHT,
  GRID_START_HOUR,
  GRID_END_HOUR,
  GRID_TOTAL_HEIGHT,
  RULER_WIDTH,
  LANE_HEADER_HEIGHT,
} from '@pvot/ui/lanes/GlassLane';
import { ConflictPanel }  from '@pvot/ui/ghost/ConflictPanel';
import type { Meeting }   from '@pvot/core/types';

// ─── DESIGN TOKENS ────────────────────────────────────────────────────────────

const DS = {
  canvas:    '#F5F4F0',
  surface:   '#FFFFFF',
  accent:    '#E8441A',
  divider:   '#DAD6CE',
  textPri:   '#1A1A18',
  textSec:   '#6B6860',
  textMut:   '#A8A49F',
  green:     '#2D9E5F',
  greenSoft: '#EDFAF3',
  amber:     '#D4830A',
  amberSoft: '#FFF5E0',
  red:       '#DC2626',
  redSoft:   '#FEF2F2',
  fontBody:  '"IBM Plex Sans", system-ui, sans-serif',
  fontMono:  '"IBM Plex Mono", monospace',
  ease:      'cubic-bezier(0.4, 0, 0.2, 1)',
} as const;

const LANE_ACCENTS = ['#E8441A', '#D4830A', '#2D9E5F', '#7C3AED', '#0891B2'] as const;
const LANE_SOFT    = ['#FFF1ED', '#FFF5E0', '#EDFAF3', '#F3EEFF', '#E0F7FF'] as const;
const BROWSER_TZ   = Intl.DateTimeFormat().resolvedOptions().timeZone;

// ─── TIMEZONE DATA ────────────────────────────────────────────────────────────

const ALL_ZONES = typeof Intl !== 'undefined' && Intl.supportedValuesOf
  ? Intl.supportedValuesOf('timeZone').map(tz => {
      const parts  = tz.split('/');
      const city   = (parts[parts.length - 1] || '').replace(/_/g, ' ');
      const region = parts.length > 1 ? parts[0].replace(/_/g, ' ') : '';
      return { tz, label: region ? `${city} (${region})` : city, shortLabel: city };
    }).sort((a, b) => a.label.localeCompare(b.label))
  : [
      { label: 'London (Europe)',    shortLabel: 'London',    tz: 'Europe/London' },
      { label: 'Lagos (Africa)',     shortLabel: 'Lagos',     tz: 'Africa/Lagos' },
      { label: 'New York (America)', shortLabel: 'New York',  tz: 'America/New_York' },
      { label: 'Dubai (Asia)',       shortLabel: 'Dubai',     tz: 'Asia/Dubai' },
      { label: 'Singapore (Asia)',   shortLabel: 'Singapore', tz: 'Asia/Singapore' },
      { label: 'Tokyo (Asia)',       shortLabel: 'Tokyo',     tz: 'Asia/Tokyo' },
    ];

function cityFromTz(tz: string): string {
  const parts = tz.split('/');
  return (parts[parts.length - 1] || tz).replace(/_/g, ' ');
}

// ─── UTILS ────────────────────────────────────────────────────────────────────

function computeNowTopPx(timezone: string, targetDateMs: number): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour: 'numeric', minute: 'numeric', hour12: false,
    }).formatToParts(new Date(targetDateMs));
    const rawHour = Number(parts.find(p => p.type === 'hour')?.value   ?? '0');
    const minute  = Number(parts.find(p => p.type === 'minute')?.value ?? '0');
    const hour    = rawHour === 24 ? 0 : rawHour;
    if (hour < GRID_START_HOUR || hour >= GRID_END_HOUR) return null;
    return Math.round((hour + minute / 60 - GRID_START_HOUR) * HOUR_HEIGHT);
  } catch { return null; }
}

function convertTime(time: string, from: string, to: string): string {
  try {
    const [rawH, rawM] = time.split(':');
    const hh = parseInt(rawH, 10) || 0;
    const mm = parseInt(rawM, 10) || 0;
    const base = new Date();
    base.setHours(hh, mm, 0, 0);
    const fromFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: from, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(base);
    const [fh, fm] = fromFmt.split(':').map(Number);
    const corrected = new Date(base.getTime() + (hh * 60 + mm - fh * 60 - fm) * 60_000);
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: to, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(corrected);
  } catch { return '--:--'; }
}

// ─── LIVE CLOCK ───────────────────────────────────────────────────────────────

function LiveClock({ tz, isPrimary }: { tz: string; isPrimary: boolean }) {
  const timeRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
    const tick = () => { if (timeRef.current) timeRef.current.textContent = fmt.format(new Date()); };
    tick();
    const iv = setInterval(tick, 1_000);
    return () => clearInterval(iv);
  }, [tz]);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
      padding: '0 12px', borderRight: `1px solid ${DS.divider}`, gap: 2, flexShrink: 0,
    }}>
      <span style={{
        fontFamily: DS.fontBody, fontSize: 8, fontWeight: 700,
        color: isPrimary ? DS.accent : DS.textMut,
        letterSpacing: '0.07em', textTransform: 'uppercase', lineHeight: 1,
      }}>
        {cityFromTz(tz)}{isPrimary ? '\u00a0·\u00a0ANCHOR' : ''}
      </span>
      <span ref={timeRef} style={{
        fontFamily: DS.fontMono, fontSize: 13, fontWeight: 700,
        color: isPrimary ? DS.textPri : DS.textSec,
        lineHeight: 1, letterSpacing: '0.03em',
      }}>
        --:--:--
      </span>
    </div>
  );
}

// ─── ACCOUNT AVATAR ───────────────────────────────────────────────────────────
// Renders Google profile photo if available, falls back to initials.

function AccountAvatar({ email, displayName, photoUrl, color, size = 24 }: {
  email: string;
  displayName?: string | null;
  photoUrl?: string | null;
  color: string;
  size?: number;
}) {
  const [imgError, setImgError] = useState(false);
  const initials = (displayName ?? email)
    .split(/\s+/)
    .slice(0, 2)
    .map(s => s[0]?.toUpperCase() ?? '')
    .join('');

  if (photoUrl && !imgError) {
    return (
      <div style={{
        width: size, height: size, borderRadius: '50%', overflow: 'hidden',
        flexShrink: 0, border: `2px solid ${color}40`,
      }}>
        <Image
          src={photoUrl}
          alt={displayName ?? email}
          width={size}
          height={size}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          onError={() => setImgError(true)}
          referrerPolicy="no-referrer"
        />
      </div>
    );
  }

  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: `${color}22`, border: `2px solid ${color}60`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0,
    }}>
      <span style={{
        fontSize: size * 0.38, fontWeight: 700, color,
        fontFamily: DS.fontBody, lineHeight: 1,
      }}>
        {initials || '?'}
      </span>
    </div>
  );
}

// ─── SEARCHABLE ZONE SELECT ───────────────────────────────────────────────────

function SearchableZoneSelect({
  value, onChange, direction = 'down', theme = 'light',
}: {
  value: string; onChange: (tz: string) => void;
  direction?: 'up' | 'down'; theme?: 'light' | 'dark';
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef     = useRef<HTMLInputElement>(null);
  const selectedZone = ALL_ZONES.find(z => z.tz === value);

  const filteredZones = useMemo(() => {
    if (!search) return ALL_ZONES;
    const s = search.toLowerCase();
    return ALL_ZONES.filter(z =>
      z.label.toLowerCase().includes(s) || z.tz.toLowerCase().includes(s)
    ).slice(0, 50);
  }, [search]);

  useEffect(() => {
    const fn = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setIsOpen(false);
    };
    document.addEventListener('mousedown', fn);
    return () => document.removeEventListener('mousedown', fn);
  }, []);

  const isDark = theme === 'dark';

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%' }}>
      <button
        onClick={e => {
          e.stopPropagation();
          setIsOpen(v => !v);
          setSearch('');
          if (!isOpen) setTimeout(() => inputRef.current?.focus(), 50);
        }}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: isDark ? 'transparent' : DS.canvas,
          border: isDark ? 'none' : `1px solid ${DS.divider}`,
          borderRadius: 6, padding: isDark ? '0 12px 0 0' : '8px 10px',
          cursor: 'pointer', outline: 'none', textAlign: 'left',
        }}
      >
        <span style={{
          fontSize: 9, fontWeight: 800,
          color: isDark ? 'rgba(255,255,255,0.5)' : DS.textPri,
          letterSpacing: '0.08em', textTransform: 'uppercase',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {selectedZone?.shortLabel || 'Select Zone'}
        </span>
        <ChevronDown size={10} color={isDark ? 'rgba(255,255,255,0.5)' : DS.textMut} />
      </button>
      {isOpen && (
        <div style={{
          position: 'absolute',
          [direction === 'up' ? 'bottom' : 'top']: '100%',
          left: 0, width: 240, zIndex: 1000,
          background: DS.surface, border: `1px solid ${DS.divider}`,
          borderRadius: 10,
          marginTop: direction === 'down' ? 6 : 0,
          marginBottom: direction === 'up' ? 6 : 0,
          boxShadow: '0 12px 40px rgba(0,0,0,0.15)',
          overflow: 'hidden', display: 'flex', flexDirection: 'column',
        }}>
          <div style={{
            padding: 8, borderBottom: `1px solid ${DS.divider}`,
            display: 'flex', alignItems: 'center', gap: 8, background: DS.canvas,
          }}>
            <Search size={14} color={DS.textMut} />
            <input
              ref={inputRef} type="text" placeholder="Type city name…"
              value={search} onChange={e => setSearch(e.target.value)}
              style={{
                border: 'none', background: 'transparent', outline: 'none',
                fontSize: 12, fontFamily: DS.fontBody, width: '100%', color: DS.textPri,
              }}
            />
          </div>
          <div style={{ maxHeight: 250, overflowY: 'auto', padding: 4 }}>
            {filteredZones.length === 0 && (
              <div style={{ padding: '12px 8px', fontSize: 11, color: DS.textMut, textAlign: 'center' }}>
                No matches found
              </div>
            )}
            {filteredZones.map(z => (
              <button key={z.tz} onClick={() => { onChange(z.tz); setIsOpen(false); }}
                style={{
                  width: '100%', padding: '8px 10px', textAlign: 'left',
                  border: 'none', borderRadius: 6,
                  background: z.tz === value ? `${DS.accent}12` : 'transparent',
                  color: z.tz === value ? DS.accent : DS.textPri,
                  fontSize: 12, fontWeight: z.tz === value ? 700 : 500,
                  cursor: 'pointer', fontFamily: DS.fontBody,
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = z.tz === value ? `${DS.accent}12` : DS.canvas; }}
                onMouseLeave={e => { e.currentTarget.style.background = z.tz === value ? `${DS.accent}12` : 'transparent'; }}
              >
                <span>{z.label}</span>
                {z.tz === value && <div style={{ width: 4, height: 4, borderRadius: '50%', background: DS.accent }} />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── TZ CONVERTER ─────────────────────────────────────────────────────────────

function TZConverter() {
  const [from, setFrom] = useState('Africa/Lagos');
  const [to, setTo]     = useState('Europe/London');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [time, setTime] = useState(() => {
    const n = new Date();
    return `${n.getHours().toString().padStart(2, '0')}:${n.getMinutes().toString().padStart(2, '0')}`;
  });

  useEffect(() => {
    const fn = (e: MouseEvent) => {
      if (ref.current && ref.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', fn);
    return () => document.removeEventListener('mousedown', fn);
  }, []);

  const result    = convertTime(time, from, to);
  const fromLabel = ALL_ZONES.find(z => z.tz === from)?.shortLabel ?? 'From';
  const toLabel   = ALL_ZONES.find(z => z.tz === to)?.shortLabel   ?? 'To';
  const [hh, mm]  = time.split(':');

  const handleHourChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let v = e.target.value.replace(/\D/g, '');
    if (v.length > 2) v = v.slice(-2);
    setTime(`${v}:${mm}`);
  };
  const handleMinChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let v = e.target.value.replace(/\D/g, '');
    if (v.length > 2) v = v.slice(-2);
    setTime(`${hh}:${v}`);
  };
  const handleBlur = () => {
    const H = Math.min(23, Math.max(0, parseInt(hh, 10) || 0));
    const M = Math.min(59, Math.max(0, parseInt(mm, 10) || 0));
    setTime(`${H.toString().padStart(2, '0')}:${M.toString().padStart(2, '0')}`);
  };
  const adjustTime = (type: 'h' | 'm', dir: 1 | -1) => {
    let H = parseInt(hh, 10) || 0;
    let M = parseInt(mm, 10) || 0;
    if (type === 'h') H = (H + dir + 24) % 24;
    else M = (M + dir + 60) % 60;
    setTime(`${H.toString().padStart(2, '0')}:${M.toString().padStart(2, '0')}`);
  };

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '5px 10px', borderRadius: 7, cursor: 'pointer',
          background: open ? `${DS.accent}12` : DS.canvas,
          border: `1.5px solid ${open ? DS.accent + '55' : DS.divider}`,
          transition: `all 0.15s ${DS.ease}`, whiteSpace: 'nowrap',
          fontFamily: DS.fontBody,
        }}
      >
        <span style={{ fontSize: 9, fontWeight: 800, color: DS.textMut, letterSpacing: '0.08em', paddingRight: 8, borderRight: `1px solid ${DS.divider}`, marginRight: 2 }}>QUICK CONVERT</span>
        <Globe style={{ width: 11, height: 11, color: open ? DS.accent : DS.textMut, flexShrink: 0 }} />
        <span style={{ fontFamily: DS.fontMono, fontSize: 11, fontWeight: 600, color: DS.textPri }}>{time}</span>
        <span style={{ fontSize: 10, color: DS.textMut, maxWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis' }}>{fromLabel}</span>
        <ArrowLeftRight style={{ width: 9, height: 9, color: DS.textMut }} />
        <span style={{ fontFamily: DS.fontMono, fontSize: 11, fontWeight: 700, color: DS.green }}>{result}</span>
        <span style={{ fontSize: 10, color: DS.textMut, maxWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis' }}>{toLabel}</span>
        <ChevronDown style={{ width: 9, height: 9, color: DS.textMut, transform: open ? 'rotate(180deg)' : 'none', transition: `transform 0.15s ${DS.ease}` }} />
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 6px)', right: 0, width: 380,
          zIndex: 400, borderRadius: 10, background: DS.surface,
          border: `1.5px solid ${DS.divider}`, boxShadow: '0 12px 40px rgba(0,0,0,0.10)',
          overflow: 'visible', fontFamily: DS.fontBody,
        }}>
          <div style={{ padding: '16px 20px', background: `${DS.accent}0C`, borderBottom: `1px solid ${DS.accent}18`, display: 'grid', gridTemplateColumns: '1.2fr auto 1.2fr', alignItems: 'center', gap: 16 }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: DS.accent, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{fromLabel}</div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <button onMouseDown={e => { e.preventDefault(); adjustTime('h', 1); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: DS.textMut, padding: '2px' }}><ChevronUp size={14} /></button>
                  <input type="text" value={hh} onChange={handleHourChange} onBlur={handleBlur} onFocus={e => e.target.select()} style={{ width: 38, height: 32, borderRadius: 4, background: DS.surface, border: `1px solid ${DS.accent}40`, fontFamily: DS.fontMono, fontSize: 16, fontWeight: 700, textAlign: 'center', outline: 'none' }} />
                  <button onMouseDown={e => { e.preventDefault(); adjustTime('h', -1); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: DS.textMut, padding: '2px' }}><ChevronDown size={14} /></button>
                </div>
                <span style={{ fontFamily: DS.fontMono, fontSize: 16, fontWeight: 700, color: DS.textMut, marginTop: -4 }}>:</span>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <button onMouseDown={e => { e.preventDefault(); adjustTime('m', 1); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: DS.textMut, padding: '2px' }}><ChevronUp size={14} /></button>
                  <input type="text" value={mm} onChange={handleMinChange} onBlur={handleBlur} onFocus={e => e.target.select()} style={{ width: 38, height: 32, borderRadius: 4, background: DS.surface, border: `1px solid ${DS.accent}40`, fontFamily: DS.fontMono, fontSize: 16, fontWeight: 700, textAlign: 'center', outline: 'none' }} />
                  <button onMouseDown={e => { e.preventDefault(); adjustTime('m', -1); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: DS.textMut, padding: '2px' }}><ChevronDown size={14} /></button>
                </div>
              </div>
            </div>
            <button onClick={() => { setFrom(to); setTo(from); }} style={{ width: 28, height: 28, borderRadius: '50%', background: DS.surface, border: `1px solid ${DS.divider}`, cursor: 'pointer', color: DS.textMut }}>⇄</button>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: DS.green, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{toLabel}</div>
              <div style={{ fontFamily: DS.fontMono, fontSize: 24, fontWeight: 700, color: DS.green }}>{result}</div>
            </div>
          </div>
          <div style={{ padding: '16px 20px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 9, fontWeight: 700, color: DS.textMut, letterSpacing: '0.08em', textTransform: 'uppercase' }}>From Zone</label>
              <SearchableZoneSelect value={from} onChange={setFrom} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 9, fontWeight: 700, color: DS.textMut, letterSpacing: '0.08em', textTransform: 'uppercase' }}>To Zone</label>
              <SearchableZoneSelect value={to} onChange={setTo} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── SETTINGS PANEL ───────────────────────────────────────────────────────────

function SettingsPanel({ onClose }: { onClose: () => void }) {
  const homeZones    = usePVOTStore((s) => (s as any).homeZones as string[] ?? []);
  const setHomeZones = usePVOTStore((s) => (s as any).setHomeZones as ((z: string[]) => void) | undefined);
  const [search, setSearch]   = useState('');
  const [dropOpen, setDropOpen] = useState(false);

  const addZone    = (tz: string) => setHomeZones?.([...homeZones, tz]);
  const removeZone = (tz: string) => setHomeZones?.(homeZones.filter(z => z !== tz));
  const moveUp     = (i: number) => {
    if (i === 0) return;
    const n = [...homeZones]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; setHomeZones?.(n);
  };
  const moveDown = (i: number) => {
    if (i >= homeZones.length - 1) return;
    const n = [...homeZones]; [n[i], n[i + 1]] = [n[i + 1], n[i]]; setHomeZones?.(n);
  };

  const filteredAdd = useMemo(() => {
    const s = search.toLowerCase();
    return ALL_ZONES
      .filter(z => !homeZones.includes(z.tz) && (z.label.toLowerCase().includes(s) || z.tz.toLowerCase().includes(s)))
      .slice(0, 40);
  }, [search, homeZones]);

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 500, display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(26,26,24,0.35)' }} />
      <div style={{ position: 'relative', width: 340, height: '100%', background: DS.surface, borderLeft: `1px solid ${DS.divider}`, display: 'flex', flexDirection: 'column', fontFamily: DS.fontBody, boxShadow: '-12px 0 40px rgba(0,0,0,0.08)', overflowY: 'auto' }}>
        <div style={{ height: 52, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 16px', borderBottom: `1px solid ${DS.divider}`, background: DS.canvas }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Settings size={14} color={DS.accent} />
            <span style={{ fontSize: 12, fontWeight: 700, color: DS.textPri }}>Settings</span>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: DS.textMut, padding: 4 }}><X size={14} /></button>
        </div>

        <div style={{ padding: '20px 16px', flex: 1 }}>
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 9, fontWeight: 800, color: DS.accent, letterSpacing: '0.10em', textTransform: 'uppercase', marginBottom: 4 }}>Home Zones</div>
            <p style={{ fontSize: 11, color: DS.textMut, lineHeight: 1.6, margin: 0 }}>
              Pin cities to show live clocks in the header ribbon. The first zone anchors the calendar grid.
            </p>
          </div>

          {homeZones.length === 0 && (
            <div style={{ padding: '14px 12px', borderRadius: 8, background: DS.canvas, border: `1px dashed ${DS.divider}`, textAlign: 'center', marginBottom: 12 }}>
              <span style={{ fontSize: 11, color: DS.textMut }}>No zones pinned yet.</span>
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
            {homeZones.map((tz, i) => (
              <div key={tz} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 7, background: i === 0 ? `${DS.accent}0A` : DS.canvas, border: `1px solid ${i === 0 ? DS.accent + '30' : DS.divider}` }}>
                {i === 0 && (
                  <span style={{ fontSize: 7, fontWeight: 800, color: DS.accent, background: `${DS.accent}18`, padding: '2px 5px', borderRadius: 3, letterSpacing: '0.06em', textTransform: 'uppercase', flexShrink: 0 }}>
                    ANCHOR
                  </span>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: DS.textPri, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{cityFromTz(tz)}</div>
                  <div style={{ fontSize: 10, color: DS.textMut }}>{tz}</div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 1, flexShrink: 0 }}>
                  <button onClick={() => moveUp(i)} disabled={i === 0} style={{ background: 'none', border: 'none', padding: '1px 3px', cursor: i === 0 ? 'default' : 'pointer', color: i === 0 ? DS.divider : DS.textMut }}><ChevronUp size={10} /></button>
                  <button onClick={() => moveDown(i)} disabled={i >= homeZones.length - 1} style={{ background: 'none', border: 'none', padding: '1px 3px', cursor: i >= homeZones.length - 1 ? 'default' : 'pointer', color: i >= homeZones.length - 1 ? DS.divider : DS.textMut }}><ChevronDown size={10} /></button>
                </div>
                <button onClick={() => removeZone(tz)} style={{ background: 'none', border: 'none', padding: 4, cursor: 'pointer', color: DS.textMut, flexShrink: 0, borderRadius: 4 }}
                  onMouseEnter={e => { e.currentTarget.style.color = DS.red; }}
                  onMouseLeave={e => { e.currentTarget.style.color = DS.textMut; }}>
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>

          <div style={{ position: 'relative' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 7, background: DS.canvas, border: `1px solid ${DS.divider}` }}>
              <Search size={12} color={DS.textMut} />
              <input
                type="text" placeholder="Add a city or timezone…" value={search}
                onChange={e => { setSearch(e.target.value); setDropOpen(true); }}
                onFocus={() => setDropOpen(true)}
                style={{ border: 'none', background: 'transparent', outline: 'none', fontSize: 12, fontFamily: DS.fontBody, width: '100%', color: DS.textPri }}
              />
            </div>
            {dropOpen && filteredAdd.length > 0 && (
              <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, maxHeight: 220, overflowY: 'auto', zIndex: 100, background: DS.surface, border: `1px solid ${DS.divider}`, borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.10)', padding: 4 }}>
                {filteredAdd.map(z => (
                  <button key={z.tz} onClick={() => { addZone(z.tz); setSearch(''); setDropOpen(false); }}
                    style={{ width: '100%', padding: '8px 10px', textAlign: 'left', border: 'none', borderRadius: 6, background: 'transparent', color: DS.textPri, fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: DS.fontBody }}
                    onMouseEnter={e => { e.currentTarget.style.background = DS.canvas; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <span style={{ fontWeight: 600 }}>{z.shortLabel}</span>
                    <span style={{ color: DS.textMut, marginLeft: 6, fontSize: 11 }}>{z.tz}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── RSVP BADGE ──────────────────────────────────────────────────────────────

function RsvpBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; bg: string; color: string }> = {
    accepted:    { label: 'Accepted',  bg: '#EDFAF3', color: '#2D9E5F' },
    declined:    { label: 'Declined',  bg: '#FEF2F2', color: '#DC2626' },
    tentative:   { label: 'Maybe',     bg: '#FFF5E0', color: '#D4830A' },
    needsAction: { label: 'Pending',   bg: '#F5F4F0', color: '#A8A49F' },
  };
  const s = map[status] ?? map.needsAction;
  return (
    <span style={{ fontSize: 8, fontWeight: 700, padding: '2px 5px', borderRadius: 3, background: s.bg, color: s.color, letterSpacing: '0.04em', flexShrink: 0 }}>
      {s.label}
    </span>
  );
}

// ─── CONTEXT PANEL ────────────────────────────────────────────────────────────

function ContextPanel({ meeting, onClose, timezone }: {
  meeting:  Meeting & { accountId?: string };
  onClose:  () => void;
  timezone: string;
}) {
  const m = meeting as any; // videoLink, selfRsvp, organizer may be on extended Meeting

  const fmt = (iso: string) => {
    try {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(new Date(iso));
    } catch { return '--:--'; }
  };

  const startTime = fmt(meeting.startUtc);
  const endTime   = fmt(meeting.endUtc);

  const durationMins = Math.round(
    (new Date(meeting.endUtc).getTime() - new Date(meeting.startUtc).getTime()) / 60_000
  );
  const durationLabel = durationMins >= 60
    ? `${Math.floor(durationMins / 60)}h${durationMins % 60 > 0 ? ` ${durationMins % 60}m` : ''}`
    : `${durationMins}m`;

  // Video join URL — from videoLink object or raw hangoutLink
  const joinUrl: string | null =
    m.videoLink?.url ?? m.videoLink ?? m.hangoutLink ?? null;
  const joinLabel: string =
    m.videoLink?.label ?? (joinUrl?.includes('meet.google') ? 'Join Google Meet' : joinUrl?.includes('zoom') ? 'Join Zoom' : joinUrl?.includes('teams') ? 'Join Teams' : 'Join Call');

  const attendees: any[] = meeting.attendees ?? [];
  const organizer = m.organizer;
  const organizerEmail = typeof organizer === 'string' ? organizer : organizer?.email ?? null;

  // Self RSVP
  const selfRsvp = m.selfRsvp ?? attendees.find((a: any) => a.self)?.status ?? null;

  return (
    <div style={{ width: 290, flexShrink: 0, background: DS.surface, borderLeft: `1px solid ${DS.divider}`, display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: DS.fontBody }}>

      {/* Accent top bar */}
      <div style={{ height: 3, background: DS.accent, flexShrink: 0 }} />

      {/* Header */}
      <div style={{ padding: '12px 14px 10px', borderBottom: `1px solid ${DS.divider}`, flexShrink: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
          <span style={{ fontSize: 9, fontWeight: 700, color: DS.accent, letterSpacing: '0.10em', textTransform: 'uppercase' }}>Meeting Detail</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: DS.textMut, cursor: 'pointer', padding: 0, lineHeight: 1 }}><X size={12} /></button>
        </div>
        <h3 style={{ fontSize: 13, fontWeight: 700, color: DS.textPri, lineHeight: 1.4, margin: '0 0 8px' }}>{meeting.title}</h3>

        {/* Time row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: selfRsvp ? 8 : 0 }}>
          <Clock size={10} color={DS.textMut} />
          <span style={{ fontFamily: DS.fontMono, fontSize: 11, fontWeight: 600, color: DS.textSec }}>
            {startTime} – {endTime}
          </span>
          <span style={{ fontSize: 10, color: DS.textMut }}>· {durationLabel}</span>
        </div>

        {/* Self RSVP */}
        {selfRsvp && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ fontSize: 9, color: DS.textMut }}>Your RSVP:</span>
            <RsvpBadge status={selfRsvp} />
          </div>
        )}
      </div>

      {/* Scrollable body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 14 }}>

        {/* JOIN BUTTON — most important action */}
        {joinUrl && (
          <a
            href={joinUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              padding: '10px 16px', borderRadius: 8, textDecoration: 'none',
              background: DS.accent, color: '#fff', fontSize: 12, fontWeight: 700,
              boxShadow: `0 2px 12px ${DS.accent}40`,
              transition: `opacity 0.15s ${DS.ease}`,
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.opacity = '0.88'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}
          >
            {/* Video camera icon inline SVG */}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="23 7 16 12 23 17 23 7" />
              <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
            </svg>
            {joinLabel}
          </a>
        )}

        {/* Open in Google Calendar */}
        {meeting.htmlLink && (
          <a
            href={meeting.htmlLink}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'flex', alignItems: 'center', gap: 6, fontSize: 11,
              color: DS.textSec, textDecoration: 'none', justifyContent: 'center',
              padding: '6px 0',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = DS.accent; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = DS.textSec; }}
          >
            <FileText size={11} />
            Open in Google Calendar
          </a>
        )}

        {/* Location */}
        {meeting.location && !joinUrl && (
          <div style={{ fontSize: 11, color: DS.textSec, background: DS.canvas, padding: '8px 10px', borderRadius: 6 }}>
            📍 {meeting.location}
          </div>
        )}

        {/* Attendees */}
        {attendees.length > 0 && (
          <div>
            <div style={{ fontSize: 9, fontWeight: 800, color: DS.textMut, letterSpacing: '0.10em', textTransform: 'uppercase', marginBottom: 8 }}>
              Guests · {attendees.length}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {attendees.map((a, i) => {
                const name    = a.displayName || a.email;
                const initials = name.split(/\s+/).slice(0, 2).map((s: string) => s[0]?.toUpperCase() ?? '').join('');
                const rsvp    = a.status ?? a.responseStatus ?? 'needsAction';
                const isOrg   = a.organizer || a.email === organizerEmail;
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', borderRadius: 6, background: a.self ? `${DS.accent}08` : 'transparent', border: a.self ? `1px solid ${DS.accent}20` : '1px solid transparent' }}>
                    {/* Avatar */}
                    <div style={{ width: 24, height: 24, borderRadius: '50%', background: a.self ? `${DS.accent}22` : `${DS.divider}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 9, fontWeight: 700, color: a.self ? DS.accent : DS.textMut }}>
                      {initials || '?'}
                    </div>
                    {/* Name + email */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 11, fontWeight: a.self ? 700 : 500, color: DS.textPri, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {name}{a.self ? ' (you)' : ''}{isOrg ? ' · Organizer' : ''}
                      </div>
                      {a.displayName && (
                        <div style={{ fontSize: 9, color: DS.textMut, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.email}</div>
                      )}
                    </div>
                    <RsvpBadge status={rsvp} />
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Description */}
        {meeting.description && (
          <div>
            <div style={{ fontSize: 9, fontWeight: 800, color: DS.textMut, letterSpacing: '0.10em', textTransform: 'uppercase', marginBottom: 6 }}>Description</div>
            <p style={{ fontSize: 11, color: DS.textSec, lineHeight: 1.6, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {meeting.description.replace(/<[^>]+>/g, '').slice(0, 400)}
              {meeting.description.length > 400 ? '…' : ''}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── EMPTY STATE ──────────────────────────────────────────────────────────────

function EmptyState({ onConnect, isConnecting }: { onConnect: () => void; isConnecting: boolean }) {
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 28, padding: 48, background: DS.canvas, fontFamily: DS.fontBody }}>
      <div style={{ textAlign: 'center', maxWidth: 400 }}>
        <div style={{ width: 52, height: 52, borderRadius: 13, margin: '0 auto 18px', background: DS.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: `0 4px 20px ${DS.accent}40` }}>
          <Zap size={22} color="#fff" />
        </div>
        <h2 style={{ fontSize: 19, fontWeight: 700, color: DS.textPri, marginBottom: 9 }}>Executive Command Center</h2>
        <p style={{ fontSize: 13, color: DS.textSec, lineHeight: 1.7 }}>Connect your Google accounts to see all meetings in parallel lanes.</p>
      </div>
      <button
        onClick={onConnect}
        disabled={isConnecting}
        style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '10px 22px', borderRadius: 8, background: DS.accent, border: 'none', color: '#fff', fontSize: 13, fontWeight: 700, cursor: isConnecting ? 'wait' : 'pointer', opacity: isConnecting ? 0.7 : 1 }}
      >
        <Plus size={14} />
        {isConnecting ? 'Connecting…' : 'Connect Google Account'}
      </button>
    </div>
  );
}

// ─── DASHBOARD PAGE ───────────────────────────────────────────────────────────

export default function DashboardPage() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const accounts  = useAuthStore(s => s.accounts);
  const conflicts = usePVOTStore(s => s.conflicts);
  const dismissed = usePVOTStore(s => s.dismissedConflicts);
  const laneConfigs    = usePVOTStore(s => s.laneConfigs);
  const viewDate       = usePVOTStore(s => s.viewDate);
  const setViewDate    = usePVOTStore(s => s.setViewDate);

  const { lanes, refetchAll, timezone, homeZones } = useLaneQuery();

  // Prevent server/client hydration mismatch — Zustand persist only runs client-side
  if (!mounted) return null;
  const { connect: connectAccount, isConnecting, error: connectError } = useConnectAccount();

  const [selectedMeeting, setSelectedMeeting] = useState<(Meeting & { accountId?: string }) | null>(null);
  const [settingsOpen, setSettingsOpen]        = useState(false);
  const calendarRef = useRef<HTMLDivElement>(null);

  const [timeOffsetMs, setTimeOffsetMs] = useState(0);
  const [baseTime, setBaseTime]         = useState(() => Date.now());

  const [ttZone1, setTtZone1] = useState(() => homeZones[0] ?? 'Europe/London');
  const [ttZone2, setTtZone2] = useState(() => homeZones[1] ?? 'America/New_York');
  const ttInitialised = useRef(false);
  useEffect(() => {
    if (ttInitialised.current || homeZones.length === 0) return;
    setTtZone1(homeZones[0]);
    if (homeZones[1]) setTtZone2(homeZones[1]);
    ttInitialised.current = true;
  }, [homeZones]);

  // Keep baseTime ticking on minute boundary
  useEffect(() => {
    const msUntil = 60_000 - (Date.now() % 60_000);
    let iv: ReturnType<typeof setInterval>;
    const to = setTimeout(() => {
      setBaseTime(Date.now());
      iv = setInterval(() => setBaseTime(Date.now()), 60_000);
    }, msUntil);
    return () => { clearTimeout(to); clearInterval(iv); };
  }, []);

  const maxOffsetMs = useMemo(() => {
    try {
      const p = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone, hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false,
      }).formatToParts(new Date(baseTime));
      const h = Number(p.find(x => x.type === 'hour')?.value ?? '0');
      const m = Number(p.find(x => x.type === 'minute')?.value ?? '0');
      const s = Number(p.find(x => x.type === 'second')?.value ?? '0');
      return Math.max(0, 24 * 3_600_000 - ((h === 24 ? 0 : h) * 3_600_000 + m * 60_000 + s * 1_000) - 60_000);
    } catch { return 24 * 3_600_000; }
  }, [baseTime, timezone]);

  const clampedOffsetMs = Math.min(timeOffsetMs, maxOffsetMs);
  const targetDateMs    = baseTime + clampedOffsetMs;
  const nowTopPx        = computeNowTopPx(timezone, targetDateMs);

  // Auto-scroll to current time on first load
  const didAutoScroll = useRef(false);
  useEffect(() => {
    if (didAutoScroll.current || nowTopPx === null || !calendarRef.current) return;
    const el = calendarRef.current;
    el.scrollTop = Math.min(
      Math.max(0, nowTopPx + LANE_HEADER_HEIGHT - el.clientHeight / 2),
      Math.max(0, GRID_TOTAL_HEIGHT + LANE_HEADER_HEIGHT - el.clientHeight),
    );
    didAutoScroll.current = true;
  }, [nowTopPx]);

  // ── Auto-refresh when OAuth popup signals success ──────────────────────────
  // The callback page posts PVOT_ACCOUNT_CONNECTED then closes itself.
  // The storage event fires as fallback for browsers that block postMessage.
  // On first mount we also force a rehydrate in case we arrived via full redirect.
  useEffect(() => {
    // Force rehydrate on mount — handles full-page redirect flow where
    // the store may not have hydrated before this component rendered.
    useAuthStore.persist.rehydrate?.();

    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      if (e.data?.type === 'PVOT_ACCOUNT_CONNECTED') {
        useAuthStore.persist.rehydrate?.();
        setTimeout(() => refetchAll(), 400);
      }
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'pvot-auth-v1') {
        useAuthStore.persist.rehydrate?.();
        setTimeout(() => refetchAll(), 400);
      }
    };
    window.addEventListener('message', onMessage);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('storage', onStorage);
    };
  }, [refetchAll]);

  // Keyboard shortcuts
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.key === 'r' || e.key === 'R') refetchAll();
      if (e.key === 'Escape') { setSelectedMeeting(null); setSettingsOpen(false); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [refetchAll]);

  const activeConflicts  = useMemo(() => (conflicts ?? []).filter(c => !(dismissed ?? []).includes(c.id)), [conflicts, dismissed]);
  const showConflictPanel = activeConflicts.length > 0 && !selectedMeeting;
  const ribbonZones: string[] = homeZones.length > 0 ? homeZones : [BROWSER_TZ];
  const travelerDate = new Date(targetDateMs);

  const laneLabel = (lane: typeof lanes[number]) => {
    const cfg = laneConfigs?.find(c => c.accountId === lane.account.id);
    return cfg?.customLabel || lane.account.displayName?.split(' ')[0] || lane.account.email.split('@')[0];
  };

  const handleConnect = useCallback(() => connectAccount(), [connectAccount]);

  return (
    <div style={{ height: '100%', width: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: DS.canvas, fontFamily: DS.fontBody }}>
      {accounts.length === 0 ? (
        <EmptyState onConnect={handleConnect} isConnecting={isConnecting} />
      ) : (
        <>
          {/* ── HEADER RIBBON ────────────────────────────────────────────── */}
          <div style={{ flexShrink: 0, background: DS.surface, borderBottom: `1px solid ${DS.divider}`, zIndex: 30 }}>

            {/* Row 1: conflicts · lane pills · quick convert · add account · settings */}
            <div style={{ height: 42, display: 'flex', alignItems: 'center', paddingInline: 12, gap: 8 }}>
              {activeConflicts.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 9px', borderRadius: 5, flexShrink: 0, background: DS.redSoft, border: `1.5px solid ${DS.red}44` }}>
                  <AlertTriangle size={10} color={DS.red} />
                  <span style={{ fontSize: 11, fontWeight: 700, color: DS.red }}>{activeConflicts.length} conflict{activeConflicts.length !== 1 ? 's' : ''}</span>
                </div>
              )}

              {/* Lane pills with avatar */}
              <div style={{ display: 'flex', gap: 4, flex: 1, overflow: 'hidden' }}>
                {lanes.map((lane, i) => (
                  <div key={lane.account.id} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '2px 8px 2px 4px', borderRadius: 4, flexShrink: 0, background: LANE_SOFT[i % LANE_SOFT.length], border: `1px solid ${LANE_ACCENTS[i % LANE_ACCENTS.length]}44` }}>
                    <AccountAvatar
                      email={lane.account.email}
                      displayName={lane.account.displayName}
                      photoUrl={lane.account.photoUrl}
                      color={LANE_ACCENTS[i % LANE_ACCENTS.length]}
                      size={18}
                    />
                    <span style={{ fontSize: 10, fontWeight: 600, color: LANE_ACCENTS[i % LANE_ACCENTS.length] }}>
                      {laneLabel(lane)}
                    </span>
                  </div>
                ))}
              </div>

              <div style={{ marginRight: 8 }}><TZConverter /></div>

              {/* Add account button */}
              <button
                onClick={handleConnect}
                disabled={isConnecting}
                title="Connect another Google account"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, padding: '5px 10px', borderRadius: 7, flexShrink: 0, background: DS.canvas, border: `1.5px solid ${DS.divider}`, cursor: isConnecting ? 'wait' : 'pointer', transition: `all 0.15s ${DS.ease}`, fontFamily: DS.fontBody }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = DS.accent; e.currentTarget.style.color = DS.accent; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = DS.divider; e.currentTarget.style.color = DS.textMut; }}
              >
                <Plus size={11} color={DS.textMut} />
                <span style={{ fontSize: 10, fontWeight: 700, color: DS.textMut }}>
                  {isConnecting ? 'Connecting…' : 'Add Account'}
                </span>
              </button>

              <button
                onClick={() => setSettingsOpen(true)}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: 7, flexShrink: 0, background: settingsOpen ? `${DS.accent}12` : DS.canvas, border: `1.5px solid ${settingsOpen ? DS.accent + '55' : DS.divider}`, cursor: 'pointer', transition: `all 0.15s ${DS.ease}` }}
              >
                <Settings size={12} color={settingsOpen ? DS.accent : DS.textMut} />
              </button>
            </div>

            {/* Row 2: Live Home Zone clocks */}
            {ribbonZones.length > 0 && (
              <div style={{ height: 38, display: 'flex', alignItems: 'center', paddingLeft: RULER_WIDTH + 12, background: DS.canvas, borderTop: `1px solid ${DS.divider}`, overflowX: 'auto', scrollbarWidth: 'none' }}>
                {ribbonZones.map((tz, i) => (
                  <LiveClock key={tz} tz={tz} isPrimary={i === 0} />
                ))}
              </div>
            )}
          </div>

          {/* ── MAIN CANVAS ──────────────────────────────────────────────── */}
          <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
              <div
                ref={calendarRef}
                style={{ flex: 1, overflowY: 'auto', overflowX: 'auto', scrollbarWidth: 'thin', scrollbarColor: `${DS.divider} transparent` }}
              >
                <div style={{ display: 'flex', minHeight: '100%' }}>
                  <TimeRuler />
                  <div style={{ display: 'flex', flex: 1 }}>
                    {lanes.map((lane, i) => (
                      <div
                        key={lane.account.id}
                        style={{ flex: 1, minWidth: 200, borderRight: i < lanes.length - 1 ? `1px solid ${DS.divider}` : 'none' }}
                        onClick={e => {
                          const el = (e.target as HTMLElement).closest('[data-meeting-id]') as HTMLElement | null;
                          if (!el?.dataset?.meetingId) return;
                          const mtg = lane.events.find(m => m?.id === el.dataset.meetingId);
                          if (mtg) setSelectedMeeting({ ...mtg, accountId: lane.account.id });
                        }}
                      >
                        <GlassLane
                          lane={lane}
                          conflicts={activeConflicts}
                          nowTopPx={nowTopPx}
                          timezone={timezone}
                          timeOffsetMs={clampedOffsetMs}
                          viewDate={viewDate}
                          laneLabel={laneLabel(lane)}
                          laneEmail={lane.account.email}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* ── TIME TRAVELLER ─────────────────────────────────────── */}
              <div style={{ height: 60, background: DS.textPri, color: 'white', display: 'flex', alignItems: 'center', padding: '0 24px', justifyContent: 'space-between', flexShrink: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap' }}>TIME TRAVELLER</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginLeft: 24, paddingLeft: 24, borderLeft: `1px solid rgba(255,255,255,0.1)`, minWidth: 260 }}>
                  <span style={{ fontSize: 9, fontWeight: 800, color: DS.accent, padding: '3px 6px', background: `${DS.accent}25`, borderRadius: 4, letterSpacing: '0.05em', marginRight: 8, transition: 'opacity 0.2s ease', visibility: clampedOffsetMs > 0 ? 'visible' : 'hidden', opacity: clampedOffsetMs > 0 ? 1 : 0 }}>PREDICTIVE</span>
                  <div style={{ display: 'flex', flexDirection: 'column', width: 90 }}>
                    <SearchableZoneSelect value={ttZone1} onChange={setTtZone1} direction="up" theme="dark" />
                    <span style={{ fontFamily: DS.fontMono, fontSize: 13, fontWeight: 700, color: clampedOffsetMs > 0 ? DS.accent : '#FFF' }}>
                      {travelerDate.toLocaleTimeString('en-GB', { timeZone: ttZone1, hour: '2-digit', minute: '2-digit', hour12: false })}
                    </span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', width: 90, paddingLeft: 16, borderLeft: `1px solid rgba(255,255,255,0.1)` }}>
                    <SearchableZoneSelect value={ttZone2} onChange={setTtZone2} direction="up" theme="dark" />
                    <span style={{ fontFamily: DS.fontMono, fontSize: 13, fontWeight: 700, color: clampedOffsetMs > 0 ? DS.accent : '#FFF' }}>
                      {travelerDate.toLocaleTimeString('en-GB', { timeZone: ttZone2, hour: '2-digit', minute: '2-digit', hour12: false })}
                    </span>
                  </div>
                </div>
                <div style={{ flex: 1, margin: '0 30px', display: 'flex', alignItems: 'center', gap: 16 }}>
                  <span style={{ fontSize: 11, opacity: 0.7 }}>NOW</span>
                  <input
                    type="range" min="0" max={maxOffsetMs} step={1000} value={clampedOffsetMs}
                    onChange={e => {
                      const newOffset = Number(e.target.value);
                      if (calendarRef.current) {
                        const p = computeNowTopPx(timezone, baseTime + newOffset);
                        if (p !== null) calendarRef.current.scrollTop = Math.round(Math.max(0, p + LANE_HEADER_HEIGHT - calendarRef.current.clientHeight / 2));
                      }
                      setTimeOffsetMs(newOffset);
                    }}
                    style={{ flex: 1, cursor: 'pointer', accentColor: DS.accent }}
                  />
                  <span style={{ fontSize: 11, opacity: 0.7 }}>+{Math.floor(maxOffsetMs / 3_600_000)}H</span>
                  <button
                    onClick={() => {
                      setTimeOffsetMs(0);
                      if (calendarRef.current) {
                        const p = computeNowTopPx(timezone, baseTime);
                        if (p !== null) calendarRef.current.scrollTo({ top: Math.max(0, p + LANE_HEADER_HEIGHT - calendarRef.current.clientHeight / 2), behavior: 'smooth' });
                      }
                    }}
                    style={{ padding: '4px 10px', marginLeft: 8, borderRadius: 6, background: `${DS.accent}25`, border: `1px solid ${DS.accent}60`, color: DS.accent, fontSize: 10, fontWeight: 800, cursor: clampedOffsetMs > 0 ? 'pointer' : 'default', transition: 'opacity 0.2s ease', visibility: clampedOffsetMs > 0 ? 'visible' : 'hidden', opacity: clampedOffsetMs > 0 ? 1 : 0 }}
                  >
                    <RotateCcw size={12} />
                  </button>
                </div>
                <div style={{ fontFamily: DS.fontMono, fontSize: 12, color: DS.accent, fontWeight: 800 }}>
                  +{String(Math.floor(clampedOffsetMs / 3_600_000)).padStart(2, '0')}:{String(Math.floor((clampedOffsetMs % 3_600_000) / 60_000)).padStart(2, '0')}H
                </div>
              </div>
            </div>

            {showConflictPanel && <ConflictPanel />}
            {selectedMeeting   && <ContextPanel meeting={selectedMeeting} onClose={() => setSelectedMeeting(null)} timezone={timezone} />}
          </div>
        </>
      )}

      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}

      <style dangerouslySetInnerHTML={{ __html: `
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600;700&display=swap');
        @keyframes pvot-pulse   { 0%,100%{opacity:1} 50%{opacity:0.25} }
        @keyframes pvot-shimmer { 0%,100%{opacity:0.4} 50%{opacity:0.2} }
        ::-webkit-scrollbar { display:none }
      `}} />
    </div>
  );
}
