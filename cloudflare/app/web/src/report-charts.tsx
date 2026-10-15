import { useEffect, useId, useRef, useState } from "react";
import { isReportValue, reportChartMaximum, reportNumber } from "./report-state";

export interface ChartPoint { label: string; current: number | null; previous?: number | null; previousLabel?: string }
const axisNumber = (value: number) => new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 }).format(value);

/** Exact values and the dates of both series remain available without the SVG. */
export function ReportTrend({ title, description, points, unit = "tarefas", compare = false }: { title: string; description: string; points: ChartPoint[]; unit?: string; compare?: boolean }) {
  const id = useId();
  const currentValues = points.map((point) => point.current).filter(isReportValue);
  const previousValues = compare ? points.map((point) => point.previous).filter(isReportValue) : [];
  const hasValues = currentValues.length > 0 || previousValues.length > 0;
  const svg = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(680);
  useEffect(() => {
    if (!svg.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setWidth(Math.max(160, Math.round(entry.contentRect.width)));
    });
    observer.observe(svg.current);
    return () => observer.disconnect();
  }, [hasValues]);
  const maximum = reportChartMaximum([...currentValues, ...previousValues]);
  const x = (index: number) => points.length === 1 ? width / 2 : 48 + index * (width - 96) / Math.max(1, points.length - 1);
  const y = (value: number) => 184 - value / maximum * 148;
  const path = (previous = false) => {
    let connected = false;
    return points.map((point, index) => {
      const value = previous ? point.previous : point.current;
      if (!isReportValue(value)) { connected = false; return ""; }
      const segment = `${connected ? "L" : "M"}${x(index)},${y(value)}`;
      connected = true;
      return segment;
    }).join(" ");
  };
  return <figure className="report-chart" aria-labelledby={`${id}-title`}>
    <figcaption><h3 id={`${id}-title`}>{title}</h3><p>{description}</p></figcaption>
    {!hasValues ? <div className="report-chart-empty"><strong>Sem dados acompanhados</strong><p>Este intervalo ainda não tem cobertura para comparar entregas. Ausência de dados não significa zero tarefas.</p></div> : <>
      <svg ref={svg} viewBox={`0 0 ${width} 232`} role="img" aria-label={`${title}. ${points.length} intervalos. Valores e datas exatos na tabela a seguir.`}>
        {[0, .5, 1].map((ratio) => <g key={ratio}><line x1="48" y1={y(ratio * maximum)} x2={width - 48} y2={y(ratio * maximum)} className="chart-grid" /><text x="37" y={y(ratio * maximum) + 4} textAnchor="end">{axisNumber(ratio * maximum)}</text></g>)}
        {compare && <path d={path(true)} className="chart-previous" fill="none" />}
        <path d={path()} className="chart-current" fill="none" />
        {points.map((point, index) => <g key={`${point.label}-${index}`}>
          {compare && isReportValue(point.previous) && <circle cx={x(index)} cy={y(point.previous)} r="4" className="chart-dot-previous" />}
          {isReportValue(point.current) && <circle cx={x(index)} cy={y(point.current)} r="3" className="chart-dot" />}
          <title>{`${point.label}: ${reportNumber(point.current)} ${unit}${compare ? `; ${point.previousLabel ?? "período anterior"}: ${reportNumber(point.previous)}` : ""}`}</title>
          {(index === 0 || index === points.length - 1 || (width >= 480 && points.length < 5 && point.label.length <= 6)) && <text x={x(index)} y="214" textAnchor={points.length === 1 ? "middle" : index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}>{point.label}</text>}
        </g>)}
      </svg>
      <div className="chart-legend"><span><i className="legend-current" aria-hidden="true" />Período selecionado</span>{compare && <span><i className="legend-previous" aria-hidden="true" />Período anterior</span>}</div>
      {currentValues.length === 0 ? <p className="report-chart-note">O período selecionado não tem dados acompanhados. A linha tracejada mostra somente o anterior.</p> : currentValues.every((value) => value === 0) && <p className="report-chart-note">Nenhuma conclusão nos intervalos acompanhados do período selecionado.</p>}
      {(currentValues.length < points.length || (compare && previousValues.length < points.length)) && <p className="report-chart-note">Lacunas indicam intervalos sem dados acompanhados.</p>}
    </>}
    {points.length > 0 && <details className="chart-data"><summary>Ver valores e datas do gráfico</summary><div className="report-table-wrap" role="region" aria-label={`Dados de ${title}`} tabIndex={0}><table><caption>{title}, em {unit}</caption><thead><tr><th scope="col">Data selecionada</th><th scope="col">Concluídas</th>{compare && <><th scope="col">Data anterior</th><th scope="col">Concluídas</th></>}</tr></thead><tbody>{points.map((point, index) => <tr key={index}><th scope="row">{point.label}</th><td className="report-numeric">{reportNumber(point.current)}</td>{compare && <><td>{point.previousLabel ?? "Não disponível"}</td><td className="report-numeric">{reportNumber(point.previous)}</td></>}</tr>)}</tbody></table></div></details>}
  </figure>;
}

export function ReportBars({ title, description, items, unit = "tarefas" }: { title: string; description: string; items: { label: string; value: number | null; detail?: string }[]; unit?: string }) {
  const id = useId();
  const observed = items.map((item) => item.value).filter(isReportValue);
  const max = Math.max(1, ...observed);
  return <figure className="report-chart report-bars" aria-labelledby={`${id}-title`}><figcaption><h3 id={`${id}-title`}>{title}</h3><p>{description}</p></figcaption>
    {!observed.length ? <div className="report-chart-empty"><strong>Resultados ainda sem cobertura</strong><p>Conclusões, falhas e cancelamentos aparecerão quando houver execuções acompanhadas neste período.</p></div> : <ul>{items.map((item, index) => <li key={`${item.label}-${index}`}><div><span>{item.label}</span><strong>{reportNumber(item.value)}{isReportValue(item.value) && <small> {unit === "tarefas" && item.value === 1 ? "tarefa" : unit}</small>}</strong></div>{isReportValue(item.value) && <span className="report-bar-track" aria-hidden="true"><span style={{ width: `${item.value / max * 100}%` }} /></span>}{item.detail && <p>{item.detail}</p>}</li>)}</ul>}
  </figure>;
}
