import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Metrics } from '@bizplus/shared';
export default function LatencyChart({ points }: { points: Metrics['chart'] }) {
  const data = points.map((point, index) => ({ ...point, index: index + 1, duration: point.durationMs, time: new Date(point.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }));
  return <div className="chart-canvas" aria-label="Measured durations for completed checks">
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 12, right: 8, bottom: 0, left: -28 }}>
        <defs><linearGradient id="latencyFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--cyan)" stopOpacity={0.24}/><stop offset="100%" stopColor="var(--cyan)" stopOpacity={0}/></linearGradient></defs>
        <CartesianGrid stroke="var(--line)" strokeDasharray="3 6" vertical={false}/>
        <XAxis dataKey="index" tickLine={false} axisLine={false} tick={{ fill: 'var(--quiet)', fontSize: 12 }} tickFormatter={value => `#${value}`} minTickGap={28}/>
        <YAxis tickLine={false} axisLine={false} tick={{ fill: 'var(--quiet)', fontSize: 12 }}/>
        <Tooltip cursor={{ stroke: 'var(--cyan)', strokeDasharray: '4 4' }} content={({ active, payload }) => active && payload?.[0] ? <div className="chart-tooltip"><strong>{Math.round(Number(payload[0].value))} ms</strong><span>{payload[0].payload.time} · {payload[0].payload.passed ? 'Passed' : 'Failed'}</span></div> : null}/>
        <Area type="monotone" dataKey="duration" stroke="var(--cyan)" strokeWidth={2.2} fill="url(#latencyFill)" dot={{ r: 3, fill: 'var(--cyan)', strokeWidth: 0 }} activeDot={{ r: 5 }}/>
      </AreaChart>
    </ResponsiveContainer>
  </div>;
}
