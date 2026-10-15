import { useId } from "react";

export interface ChartPoint { label: string; current: number | null; previous?: number | null }
const number = (value: number) => new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(value);

/** The table is the accessible source of exact values; SVG provides the visual comparison. */
export function ReportTrend({ title, description, points, unit = "tarefas", compare = false }: { title: string; description: string; points: ChartPoint[]; unit?: string; compare?: boolean }) {
  const id = useId();
  const maximum = Math.max(1, ...points.flatMap((point) => [point.current ?? 0, compare ? point.previous ?? 0 : 0]));
  const x = (index: number) => 42 + index * 596 / Math.max(1, points.length - 1);
  const y = (value: number) => 184 - value / maximum * 148;
  const path = (previous = false) => {
    let connected = false;
    return points.map((point, index) => {
      const value = previous ? point.previous : point.current;
      if (value === null || value === undefined) { connected = false; return ""; }
      const segment = `${connected ? "L" : "M"}${x(index)},${y(value)}`; connected = true; return segment;
    }).join(" ");
  };
  const valueLabel = (value: number | null | undefined) => value === null || value === undefined ? "Não acompanhado" : number(value);
  return <figure className="report-chart" aria-labelledby={`${id}-title`}>
    <figcaption><h3 id={`${id}-title`}>{title}</h3><p>{description}</p></figcaption>
    {!points.length ? <p className="report-empty">Não há registros neste período para formar o gráfico.</p> : <>
      <svg viewBox="0 0 680 226" role="img" aria-label={`${title}. ${points.length} intervalos. Valores exatos na tabela a seguir.`}>
        {[0, .5, 1].map((ratio) => <g key={ratio}><line x1="42" y1={y(ratio * maximum)} x2="638" y2={y(ratio * maximum)} className="chart-grid" /><text x="32" y={y(ratio * maximum) + 4} textAnchor="end">{number(ratio * maximum)}</text></g>)}
        {compare && <path d={path(true)} className="chart-previous" fill="none" />}
        <path d={path()} className="chart-current" fill="none" />
        {points.map((point, index) => <g key={`${point.label}-${index}`}>{point.current !== null && <circle cx={x(index)} cy={y(point.current)} r="3.5" className="chart-dot" />}<title>{point.label}: {valueLabel(point.current)} {unit}{compare ? `; anterior: ${valueLabel(point.previous)}` : ""}</title>{(index === 0 || index === points.length - 1 || (points.length < 8)) && <text x={x(index)} y="210" textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}>{point.label}</text>}</g>)}
      </svg>
      <div className="chart-legend"><span><i className="legend-current" />Período selecionado</span>{compare && <span><i className="legend-previous" />Período anterior</span>}</div>
      <details className="chart-data"><summary>Ver dados do gráfico</summary><div className="report-table-wrap"><table><caption>{title}, em {unit}</caption><thead><tr><th scope="col">Intervalo</th><th scope="col">Selecionado</th>{compare && <th scope="col">Anterior</th>}</tr></thead><tbody>{points.map((point, index) => <tr key={index}><th scope="row">{point.label}</th><td>{valueLabel(point.current)}</td>{compare && <td>{valueLabel(point.previous)}</td>}</tr>)}</tbody></table></div></details>
    </>}
  </figure>;
}

export function ReportBars({ title, description, items, unit = "tarefas" }: { title: string; description: string; items: { label: string; value: number; detail?: string }[]; unit?: string }) {
  const max = Math.max(1, ...items.map((item) => item.value));
  return <figure className="report-chart report-bars"><figcaption><h3>{title}</h3><p>{description}</p></figcaption>
    {!items.length ? <p className="report-empty">Nenhum registro disponível neste período.</p> : <ul>{items.map((item, index) => <li key={`${item.label}-${index}`}><div><span>{item.label}</span><strong>{number(item.value)} <small>{unit}</small></strong></div><span className="report-bar-track" aria-hidden="true"><span style={{ width: `${item.value / max * 100}%` }} /></span>{item.detail && <p>{item.detail}</p>}</li>)}</ul>}
  </figure>;
}
