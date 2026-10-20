import React, { useState } from 'react';
import {
  CitationEdge,
  CreativityMode,
  PaperNode,
} from '../types/graph';
import {
  getActualInDegree,
  getActualOutDegree,
  getCreativityValue,
} from './GraphCanvas';
import { ArrowUpRight } from 'lucide-react';

interface NodeInspectorProps {
  nodes: PaperNode[];
  edges: CitationEdge[];
  seedId: string;
  selectedNodeId: string | null;
  expandingNodeIds: Set<string>;
  creativityMode: CreativityMode;
  onSelectNode: (nodeId: string) => void;
  onExpandNode: (nodeId: string) => void;
}

export const NodeInspector: React.FC<NodeInspectorProps> = ({
  nodes,
  edges,
  seedId,
  creativityMode,
  onSelectNode,
}) => {
  const [activeTab, setActiveTab] = useState<'inspector' | 'leaderboard'>(
    'inspector'
  );

  const seedNode =
    nodes.find((n) => n.id === seedId) || nodes[0];

  const inNodes: PaperNode[] = seedNode
    ? edges
        .filter((e) => e.target === seedNode.id)
        .map((e) => nodes.find((n) => n.id === e.source))
        .filter((n): n is PaperNode => Boolean(n))
    : [];

  const outNodes: PaperNode[] = seedNode
    ? edges
        .filter((e) => e.source === seedNode.id)
        .map((e) => nodes.find((n) => n.id === e.target))
        .filter((n): n is PaperNode => Boolean(n))
    : [];

  const sortedLeaderboard = [...nodes].sort(
    (a, b) =>
      getCreativityValue(b, creativityMode) -
        getCreativityValue(a, creativityMode) ||
      getActualOutDegree(b) - getActualOutDegree(a)
  );

  return (
    <aside className="fixed top-20 right-6 bottom-5 w-[368px] apple-glass rounded-3xl flex flex-col z-20 overflow-hidden">
      {/* Apple Segmented Control Header */}
      <div className="px-5 pt-4 pb-3 border-b border-black/[0.05]">
        <div className="grid grid-cols-2 bg-black/[0.05] p-0.5 rounded-full text-xs">
          <button
            onClick={() => setActiveTab('inspector')}
            className={`py-1.5 rounded-full transition font-medium ${
              activeTab === 'inspector'
                ? 'bg-white text-[#1D1D1F] shadow-sm'
                : 'text-[#86868B] hover:text-[#1D1D1F]'
            }`}
          >
            Seed Paper
          </button>
          <button
            onClick={() => setActiveTab('leaderboard')}
            className={`py-1.5 rounded-full transition font-medium ${
              activeTab === 'leaderboard'
                ? 'bg-white text-[#1D1D1F] shadow-sm'
                : 'text-[#86868B] hover:text-[#1D1D1F]'
            }`}
          >
            Creativity Index ({nodes.length})
          </button>
        </div>
      </div>

      {activeTab === 'inspector' && seedNode ? (
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Paper Title & Metadata */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-[10px] text-[#86868B] uppercase tracking-wider font-medium">
              <span>Active Seed Node</span>
              {seedNode.year && (
                <span className="font-mono-metric">{seedNode.year}</span>
              )}
            </div>

            <h2 className="font-serif-editorial text-[19px] font-normal text-[#1D1D1F] leading-snug">
              {seedNode.title}
            </h2>

            <p className="text-xs text-[#515154]">
              {seedNode.authors.join(', ')}
            </p>

            {seedNode.venue && (
              <p className="text-[11px] text-[#86868B]">{seedNode.venue}</p>
            )}

            {seedNode.abstract_snippet && (
              <p className="text-xs text-[#515154] leading-relaxed pt-1">
                {seedNode.abstract_snippet}
              </p>
            )}
          </div>

          {/* Apple Glass Creativity Metric Card */}
          <div className="apple-glass-subtle rounded-2xl p-3.5">
            <div className="flex items-baseline justify-between mb-2.5">
              <span className="text-[10px] uppercase tracking-wider text-[#86868B] font-medium">
                Creativity Measurement
              </span>
              <span className="font-mono-metric text-[10px] text-[#86868B]">
                out_degree / in_degree
              </span>
            </div>

            <div className="grid grid-cols-3 gap-2 pt-2 border-t border-black/[0.05]">
              <div>
                <div className="text-[10px] text-[#86868B]">In-Degree</div>
                <div className="font-mono-metric text-base font-medium text-[#1D1D1F] mt-0.5">
                  {getActualInDegree(seedNode)}
                </div>
                <div className="text-[10px] text-[#86868B]">References</div>
              </div>

              <div>
                <div className="text-[10px] text-[#86868B]">Out-Degree</div>
                <div className="font-mono-metric text-base font-medium text-[#1D1D1F] mt-0.5">
                  {getActualOutDegree(seedNode)}
                </div>
                <div className="text-[10px] text-[#86868B]">Citations</div>
              </div>

              <div>
                <div className="text-[10px] text-[#D97757] font-medium">
                  Creativity
                </div>
                <div className="font-mono-metric text-base font-semibold text-[#D97757] mt-0.5">
                  {getCreativityValue(seedNode, creativityMode).toFixed(2)}
                </div>
                <div className="text-[10px] text-[#86868B] font-mono-metric">
                  {getActualOutDegree(seedNode)}/{getActualInDegree(seedNode)}
                </div>
              </div>
            </div>
          </div>

          {/* External Links Pill Row */}
          <div className="flex flex-wrap items-center gap-1.5">
            <a
              href={seedNode.google_scholar_url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-black/[0.04] hover:bg-black/[0.08] text-[#1D1D1F] text-[11px] font-medium transition"
            >
              <span>Google Scholar</span>
              <ArrowUpRight className="w-3 h-3 text-[#86868B]" />
            </a>

            <a
              href={seedNode.google_scholar_cited_by_url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-black/[0.04] hover:bg-black/[0.08] text-[#1D1D1F] text-[11px] font-medium transition"
            >
              <span>Cited By</span>
              <ArrowUpRight className="w-3 h-3 text-[#86868B]" />
            </a>

            {seedNode.pdf_url && (
              <a
                href={seedNode.pdf_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-black/[0.04] hover:bg-black/[0.08] text-[#1D1D1F] text-[11px] font-medium transition"
              >
                <span>PDF</span>
                <ArrowUpRight className="w-3 h-3 text-[#86868B]" />
              </a>
            )}

            {seedNode.doi_url && (
              <a
                href={seedNode.doi_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-black/[0.04] hover:bg-black/[0.08] text-[#1D1D1F] text-[11px] font-medium transition"
              >
                <span>DOI</span>
                <ArrowUpRight className="w-3 h-3 text-[#86868B]" />
              </a>
            )}
          </div>

          {/* References List (Click any paper to make it the new seed!) */}
          <div className="space-y-1.5 pt-2 border-t border-black/[0.05]">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-[#1D1D1F]">
                References (In-Nodes)
              </span>
              <span className="font-mono-metric text-[11px] text-[#86868B]">
                {inNodes.length} shown · {getActualInDegree(seedNode)} total
              </span>
            </div>

            {inNodes.length === 0 ? (
              <p className="text-xs text-[#86868B] py-2">
                Loading references in parallel...
              </p>
            ) : (
              <div className="divide-y divide-black/[0.04]">
                {inNodes.map((n) => (
                  <button
                    key={n.id}
                    onClick={() => onSelectNode(n.id)}
                    title="Click to make this paper the new Seed Paper"
                    className="w-full text-left py-2 hover:bg-white/60 px-2 -mx-2 rounded-xl transition flex items-baseline justify-between gap-3 group"
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-[#1D1D1F] group-hover:text-[#0071E3] truncate transition">
                        {n.title}
                      </div>
                      <div className="text-[11px] text-[#86868B] truncate">
                        {n.authors[0]} {n.year ? `(${n.year})` : ''}
                      </div>
                    </div>
                    <span className="shrink-0 font-mono-metric text-[11px] text-[#86868B]">
                      {n.creativity_score.toFixed(1)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Cited-By List (Click any paper to make it the new seed!) */}
          <div className="space-y-1.5 pt-2 border-t border-black/[0.05]">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-[#1D1D1F]">
                Cited By (Out-Nodes)
              </span>
              <span className="font-mono-metric text-[11px] text-[#86868B]">
                {outNodes.length} shown · {getActualOutDegree(seedNode)} total
              </span>
            </div>

            {outNodes.length === 0 ? (
              <p className="text-xs text-[#86868B] py-2">
                Loading citing papers in parallel...
              </p>
            ) : (
              <div className="divide-y divide-black/[0.04]">
                {outNodes.map((n) => (
                  <button
                    key={n.id}
                    onClick={() => onSelectNode(n.id)}
                    title="Click to make this paper the new Seed Paper"
                    className="w-full text-left py-2 hover:bg-white/60 px-2 -mx-2 rounded-xl transition flex items-baseline justify-between gap-3 group"
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-[#1D111F] group-hover:text-[#0071E3] truncate transition">
                        {n.title}
                      </div>
                      <div className="text-[11px] text-[#86868B] truncate">
                        {n.authors[0]} {n.year ? `(${n.year})` : ''}
                      </div>
                    </div>
                    <span className="shrink-0 font-mono-metric text-[11px] text-[#86868B]">
                      {n.creativity_score.toFixed(1)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Creativity Index Leaderboard (Clicking any paper makes it the new seed!) */
        <div className="flex-1 overflow-y-auto px-5 py-3 divide-y divide-black/[0.04]">
          {sortedLeaderboard.map((node, index) => {
            const score = getCreativityValue(node, creativityMode);
            const isSeed = node.id === seedId;
            return (
              <button
                key={node.id}
                onClick={() => {
                  onSelectNode(node.id);
                  setActiveTab('inspector');
                }}
                className={`w-full text-left py-2.5 px-2.5 -mx-2.5 rounded-xl transition flex items-baseline justify-between gap-3 ${
                  isSeed ? 'bg-white/80 shadow-sm' : 'hover:bg-white/50'
                }`}
              >
                <div className="flex items-baseline gap-2.5 min-w-0">
                  <span className="font-mono-metric text-[11px] text-[#86868B] w-5 shrink-0">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-[#1D1D1F] truncate">
                      {node.title}
                    </div>
                    <div className="text-[11px] text-[#86868B] truncate">
                      {node.authors[0] || 'Unknown'}{' '}
                      {node.year ? `(${node.year})` : ''} ·{' '}
                      <span className="font-mono-metric">
                        {getActualOutDegree(node)}/{getActualInDegree(node)}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="font-mono-metric text-xs font-medium text-[#1D1D1F] shrink-0">
                  {score.toFixed(2)}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </aside>
  );
};
