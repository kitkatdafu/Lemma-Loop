import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  CitationEdge,
  CreativityMode,
  LayoutMode,
  PaperNode,
} from '../types/graph';
import { Maximize2, ZoomIn, ZoomOut } from 'lucide-react';

interface GraphCanvasProps {
  nodes: PaperNode[];
  edges: CitationEdge[];
  seedId: string;
  selectedNodeId: string | null;
  expandingNodeIds: Set<string>;
  creativityMode: CreativityMode;
  layoutMode: LayoutMode;
  onSelectNode: (nodeId: string) => void;
  onDoubleClickNode: (nodeId: string) => void;
}

interface SimNode extends PaperNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  targetX: number;
  targetY: number;
  radius: number;
}

export function getActualOutDegree(node: PaperNode): number {
  return Math.max(node.global_citations_count, node.out_degree);
}

export function getActualInDegree(node: PaperNode): number {
  return Math.max(node.global_references_count, node.in_degree);
}

export function getCreativityValue(
  node: PaperNode,
  mode: CreativityMode
): number {
  if (mode === 'subgraph') return node.global_creativity_score;
  if (mode === 'smoothed')
    return Number(node.smoothed_creativity_score.toFixed(2));
  return node.creativity_score;
}

export function getCreativityColor(score: number, isSeed: boolean): string {
  if (isSeed) return '#1D1D1F'; // Apple Space Black
  if (score >= 25.0) return '#D97757'; // Warm Terracotta (Landmark breakthrough)
  if (score >= 10.0) return '#0071E3'; // Apple Blue (High amplifier)
  return '#86868B'; // Apple Neutral Gray (Foundational)
}

export const GraphCanvas: React.FC<GraphCanvasProps> = ({
  nodes,
  edges,
  seedId,
  selectedNodeId,
  expandingNodeIds,
  creativityMode,
  layoutMode,
  onSelectNode,
  onDoubleClickNode,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const simNodesRef = useRef<Map<string, SimNode>>(new Map());
  // Offset slightly left so the floating right glass inspector doesn't cover the right column
  const transformRef = useRef({ x: -160, y: 12, k: 0.9 });
  const dragStateRef = useRef<{
    type: 'none' | 'pan' | 'node';
    nodeId?: string;
    startX: number;
    startY: number;
    clientStartX: number;
    clientStartY: number;
    hasMoved: boolean;
  }>({
    type: 'none',
    startX: 0,
    startY: 0,
    clientStartX: 0,
    clientStartY: 0,
    hasMoved: false,
  });
  const hoveredNodeIdRef = useRef<string | null>(null);
  const [hoveredNode, setHoveredNode] = useState<PaperNode | null>(null);

  // Requirement 1: ONLY show edges directly incident to the seed paper (`u -> seed` or `seed -> w`).
  // Never show edges between any other papers.
  const seedEdges = useMemo(
    () =>
      edges.filter(
        (e) => e.source === seedId || e.target === seedId
      ),
    [edges, seedId]
  );

  // Only display the seed paper and nodes directly connected to the seed paper
  const visibleNodes = useMemo(() => {
    const connectedIds = new Set<string>([seedId]);
    for (const e of seedEdges) {
      connectedIds.add(e.source);
      connectedIds.add(e.target);
    }
    return nodes.filter((n) => connectedIds.has(n.id));
  }, [nodes, seedEdges, seedId]);

  useEffect(() => {
    const map = simNodesRef.current;

    const inBucket: PaperNode[] = [];
    const outBucket: PaperNode[] = [];

    for (const n of visibleNodes) {
      if (n.id === seedId) continue;
      const isRef = seedEdges.some(
        (e) => e.source === n.id && e.target === seedId
      );
      if (isRef) {
        inBucket.push(n);
      } else {
        outBucket.push(n);
      }
    }

    inBucket.sort((a, b) => b.creativity_score - a.creativity_score);
    outBucket.sort((a, b) => b.creativity_score - a.creativity_score);

    const activeIds = new Set<string>();
    for (const n of visibleNodes) {
      activeIds.add(n.id);
      let targetX = 0;
      let targetY = 0;

      if (n.id !== seedId) {
        const isRef = inBucket.some((item) => item.id === n.id);
        const bucket = isRef ? inBucket : outBucket;
        const idx = bucket.findIndex((item) => item.id === n.id);
        const count = bucket.length;

        const colSpacing = 360;
        const rowSpacing = Math.max(58, Math.min(86, 660 / Math.max(1, count)));
        targetX = (isRef ? -1 : 1) * colSpacing;
        targetY = (idx - (count - 1) / 2) * rowSpacing;
      }

      const cScore = getCreativityValue(n, creativityMode);
      const radius =
        n.id === seedId
          ? 27
          : Math.max(14, Math.min(22, 12 + Math.log2(1 + cScore) * 1.9));

      const existing = map.get(n.id);
      if (existing) {
        Object.assign(existing, n, {
          targetX,
          targetY,
          radius,
        });
      } else {
        map.set(n.id, {
          ...n,
          x: targetX * 0.25 + (Math.random() - 0.5) * 20,
          y: targetY * 0.25 + (Math.random() - 0.5) * 20,
          vx: 0,
          vy: 0,
          targetX,
          targetY,
          radius,
        });
      }
    }

    for (const id of Array.from(map.keys())) {
      if (!activeIds.has(id)) {
        map.delete(id);
      }
    }
  }, [visibleNodes, seedEdges, seedId, creativityMode, layoutMode]);

  useEffect(() => {
    let animationFrameId: number;
    let tick = 0;

    const render = () => {
      tick += 1;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      if (
        canvas.width !== Math.floor(rect.width * dpr) ||
        canvas.height !== Math.floor(rect.height * dpr)
      ) {
        canvas.width = Math.floor(rect.width * dpr);
        canvas.height = Math.floor(rect.height * dpr);
      }

      const width = rect.width;
      const height = rect.height;
      const simNodes = Array.from(simNodesRef.current.values());

      // Physics Step
      if (layoutMode === 'level_flow') {
        for (const node of simNodes) {
          if (
            dragStateRef.current.type === 'node' &&
            dragStateRef.current.nodeId === node.id
          ) {
            continue;
          }
          const dx = node.targetX - node.x;
          const dy = node.targetY - node.y;
          node.vx = (node.vx + dx * 0.09) * 0.72;
          node.vy = (node.vy + dy * 0.09) * 0.72;
        }
      } else {
        // Orbit / Radial mode around the seed paper
        const nonSeed = simNodes.filter((n) => n.id !== seedId);
        nonSeed.forEach((node, idx) => {
          if (
            dragStateRef.current.type === 'node' &&
            dragStateRef.current.nodeId === node.id
          ) {
            return;
          }
          const isRef = node.targetX < 0;
          const angle =
            (isRef ? Math.PI : 0) +
            ((idx / Math.max(1, nonSeed.length)) - 0.5) * Math.PI * 1.4;
          const orbitRadius = 290;
          const ox = Math.cos(angle) * orbitRadius;
          const oy = Math.sin(angle) * orbitRadius;
          node.vx = (node.vx + (ox - node.x) * 0.07) * 0.75;
          node.vy = (node.vy + (oy - node.y) * 0.07) * 0.75;
        });
        const seedSim = simNodesRef.current.get(seedId);
        if (seedSim) {
          seedSim.vx = (0 - seedSim.x) * 0.15;
          seedSim.vy = (0 - seedSim.y) * 0.15;
        }
      }

      for (const node of simNodes) {
        if (
          dragStateRef.current.type === 'node' &&
          dragStateRef.current.nodeId === node.id
        ) {
          continue;
        }
        node.x += node.vx;
        node.y += node.vy;
      }

      // Drawing Step
      ctx.save();
      ctx.scale(dpr, dpr);

      // Soft Apple Studio ambient radial canvas background
      const bgGrad = ctx.createRadialGradient(
        width * 0.42,
        height * 0.48,
        40,
        width * 0.45,
        height * 0.5,
        Math.max(width, height) * 0.75
      );
      bgGrad.addColorStop(0, '#FFFFFF');
      bgGrad.addColorStop(0.55, '#F7F7F9');
      bgGrad.addColorStop(1, '#EFEFF4');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, width, height);

      const { x: tx, y: ty, k: scale } = transformRef.current;
      const centerX = width / 2 + tx;
      const centerY = height / 2 + ty;

      // Subtle architectural micro-dots
      const dotStep = 36 * scale;
      if (dotStep > 14) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.055)';
        const startX = ((centerX % dotStep) + dotStep) % dotStep;
        const startY = ((centerY % dotStep) + dotStep) % dotStep;
        for (let gx = startX; gx < width; gx += dotStep) {
          for (let gy = startY; gy < height; gy += dotStep) {
            ctx.fillRect(gx, gy, 1.15, 1.15);
          }
        }
      }

      ctx.translate(centerX, centerY);
      ctx.scale(scale, scale);

      // Column headers in Flow mode
      if (layoutMode === 'level_flow') {
        const columns = [
          { x: -360, label: 'References · In-Nodes (u → seed)' },
          { x: 0, label: 'Seed Paper (Click any node to re-seed)' },
          { x: 360, label: 'Cited By · Out-Nodes (seed → w)' },
        ];
        for (const col of columns) {
          ctx.fillStyle = col.x === 0 ? '#1D1D1F' : '#86868B';
          ctx.font =
            col.x === 0
              ? '500 11px -apple-system, BlinkMacSystemFont, Inter, sans-serif'
              : '400 11px -apple-system, BlinkMacSystemFont, Inter, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(col.label, col.x, -395);
        }
      }

      // Draw ONLY Seed Edges (`u -> seed` or `seed -> w`) with smooth Apple-style cubic bezier curves
      for (const edge of seedEdges) {
        const u = simNodesRef.current.get(edge.source);
        const v = simNodesRef.current.get(edge.target);
        if (!u || !v) continue;

        const isHovered =
          hoveredNodeIdRef.current === u.id ||
          hoveredNodeIdRef.current === v.id;

        const isIncomingToSeed = v.id === seedId;

        const cp1x = u.x + (v.x - u.x) * 0.45;
        const cp1y = u.y;
        const cp2x = u.x + (v.x - u.x) * 0.55;
        const cp2y = v.y;

        ctx.beginPath();
        ctx.moveTo(u.x, u.y);
        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, v.x, v.y);

        if (isHovered) {
          ctx.strokeStyle = isIncomingToSeed
            ? 'rgba(217, 119, 87, 0.8)'
            : 'rgba(0, 113, 227, 0.8)';
          ctx.lineWidth = 2.0;
        } else {
          ctx.strokeStyle = 'rgba(29, 29, 31, 0.14)';
          ctx.lineWidth = 1.25;
        }
        ctx.stroke();

        // Subtle directional arrowhead near target node `v`
        const t = 0.86;
        const mt = 1 - t;
        const ax =
          mt * mt * mt * u.x +
          3 * mt * mt * t * cp1x +
          3 * mt * t * t * cp2x +
          t * t * t * v.x;
        const ay =
          mt * mt * mt * u.y +
          3 * mt * mt * t * cp1y +
          3 * mt * t * t * cp2y +
          t * t * t * v.y;
        const dxdt =
          3 * mt * mt * (cp1x - u.x) +
          6 * mt * t * (cp2x - cp1x) +
          3 * t * t * (v.x - cp2x);
        const dydt =
          3 * mt * mt * (cp1y - u.y) +
          6 * mt * t * (cp2y - cp1y) +
          3 * t * t * (v.y - cp2y);
        const angle = Math.atan2(dydt, dxdt);

        const arrowSize = isHovered ? 6 : 4.5;
        ctx.save();
        ctx.translate(ax, ay);
        ctx.rotate(angle);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(-arrowSize * 1.35, -arrowSize * 0.68);
        ctx.lineTo(-arrowSize * 1.35, arrowSize * 0.68);
        ctx.closePath();
        ctx.fillStyle = isHovered
          ? isIncomingToSeed
            ? '#D97757'
            : '#0071E3'
          : 'rgba(29, 29, 31, 0.32)';
        ctx.fill();
        ctx.restore();
      }

      // Draw Paper Nodes with Apple Glass / Soft Shadow aesthetic
      for (const node of simNodes) {
        const isSeed = node.id === seedId;
        const isHovered = node.id === hoveredNodeIdRef.current;
        const isExpanding = expandingNodeIds.has(node.id);
        const cScore = getCreativityValue(node, creativityMode);
        const accentColor = getCreativityColor(cScore, isSeed);

        if (isExpanding) {
          const pulseRadius = node.radius + 7 + Math.sin(tick * 0.12) * 3.5;
          ctx.beginPath();
          ctx.arc(node.x, node.y, pulseRadius, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(0, 113, 227, 0.45)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }

        if (isHovered) {
          ctx.beginPath();
          ctx.arc(node.x, node.y, node.radius + 5, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(0, 113, 227, 0.08)';
          ctx.fill();
        }

        // Soft elevation shadow
        ctx.save();
        ctx.shadowColor = 'rgba(0, 0, 0, 0.09)';
        ctx.shadowBlur = 14;
        ctx.shadowOffsetY = 4;

        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
        ctx.fillStyle = isSeed ? '#1D1D1F' : 'rgba(255, 255, 255, 0.94)';
        ctx.fill();
        ctx.restore();

        ctx.lineWidth = isSeed ? 2.2 : isHovered ? 2.2 : 1.5;
        ctx.strokeStyle = accentColor;
        ctx.stroke();

        // Creativity score inside circle
        ctx.fillStyle = isSeed ? '#FFFFFF' : '#1D1D1F';
        ctx.font = `500 ${Math.max(9.5, Math.min(11.5, node.radius * 0.52))}px "JetBrains Mono", monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const scoreLabel =
          cScore >= 10 ? cScore.toFixed(0) : cScore.toFixed(1);
        ctx.fillText(scoreLabel, node.x, node.y + 0.5);

        // Clean frosted glass pill label below node
        const shortTitle =
          node.title.length > 34
            ? node.title.slice(0, 32) + '…'
            : node.title;
        const firstAuthorLast =
          node.authors[0]?.split(' ').slice(-1)[0] || 'Paper';
        const actualOut = getActualOutDegree(node);
        const actualIn = getActualInDegree(node);
        const subtitle = `${firstAuthorLast} (${node.year ?? '—'}) · ${actualOut}/${actualIn}`;

        ctx.font = isSeed
          ? '500 11.5px -apple-system, BlinkMacSystemFont, Inter, sans-serif'
          : '400 11px -apple-system, BlinkMacSystemFont, Inter, sans-serif';

        const textWidth = Math.max(
          ctx.measureText(shortTitle).width,
          ctx.measureText(subtitle).width
        );
        const pillW = textWidth + 16;
        const pillH = 29;
        const pillX = node.x - pillW / 2;
        const pillY = node.y + node.radius + 6;

        ctx.fillStyle = isHovered
          ? 'rgba(255, 255, 255, 0.96)'
          : 'rgba(255, 255, 255, 0.78)';
        ctx.beginPath();
        ctx.roundRect(pillX, pillY, pillW, pillH, 8);
        ctx.fill();

        ctx.strokeStyle = isHovered
          ? 'rgba(0, 0, 0, 0.14)'
          : 'rgba(0, 0, 0, 0.05)';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle = '#1D1D1F';
        ctx.textBaseline = 'top';
        ctx.fillText(shortTitle, node.x, pillY + 3.5);

        ctx.font = '400 9.5px "JetBrains Mono", monospace';
        ctx.fillStyle = '#86868B';
        ctx.fillText(subtitle, node.x, pillY + 16.5);
      }

      ctx.restore();
      animationFrameId = requestAnimationFrame(render);
    };

    animationFrameId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animationFrameId);
  }, [
    seedEdges,
    seedId,
    selectedNodeId,
    expandingNodeIds,
    creativityMode,
    layoutMode,
  ]);

  const screenToGraph = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const { x: tx, y: ty, k: scale } = transformRef.current;
    const centerX = rect.width / 2 + tx;
    const centerY = rect.height / 2 + ty;
    return {
      x: (clientX - rect.left - centerX) / scale,
      y: (clientY - rect.top - centerY) / scale,
    };
  };

  const findNodeAt = (gx: number, gy: number): SimNode | null => {
    const simNodes = Array.from(simNodesRef.current.values());
    for (let i = simNodes.length - 1; i >= 0; i--) {
      const n = simNodes[i];
      const dx = gx - n.x;
      const dy = gy - n.y;
      if (dx * dx + dy * dy <= (n.radius + 7) * (n.radius + 7)) {
        return n;
      }
    }
    return null;
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = screenToGraph(e.clientX, e.clientY);
    const hit = findNodeAt(x, y);
    if (hit) {
      dragStateRef.current = {
        type: 'node',
        nodeId: hit.id,
        startX: e.clientX,
        startY: e.clientY,
        clientStartX: e.clientX,
        clientStartY: e.clientY,
        hasMoved: false,
      };
    } else {
      dragStateRef.current = {
        type: 'pan',
        startX: e.clientX - transformRef.current.x,
        startY: e.clientY - transformRef.current.y,
        clientStartX: e.clientX,
        clientStartY: e.clientY,
        hasMoved: false,
      };
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const drag = dragStateRef.current;
    if (drag.type === 'node' && drag.nodeId) {
      const movedDist = Math.hypot(
        e.clientX - drag.clientStartX,
        e.clientY - drag.clientStartY
      );
      if (movedDist > 4) {
        drag.hasMoved = true;
      }
      if (drag.hasMoved) {
        const { x, y } = screenToGraph(e.clientX, e.clientY);
        const node = simNodesRef.current.get(drag.nodeId);
        if (node) {
          node.x = x;
          node.y = y;
          node.vx = 0;
          node.vy = 0;
        }
      }
      return;
    }

    if (drag.type === 'pan') {
      transformRef.current.x = e.clientX - drag.startX;
      transformRef.current.y = e.clientY - drag.startY;
      drag.hasMoved = true;
      return;
    }

    const { x, y } = screenToGraph(e.clientX, e.clientY);
    const hit = findNodeAt(x, y);
    hoveredNodeIdRef.current = hit ? hit.id : null;
    setHoveredNode(hit);
  };

  const handleMouseUp = () => {
    const drag = dragStateRef.current;
    // Requirement 2: Clicking a node makes it the new seed paper!
    if (drag.type === 'node' && drag.nodeId && !drag.hasMoved) {
      onSelectNode(drag.nodeId);
    }
    dragStateRef.current = {
      type: 'none',
      startX: 0,
      startY: 0,
      clientStartX: 0,
      clientStartY: 0,
      hasMoved: false,
    };
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.08 : 0.92;
    transformRef.current.k = Math.max(
      0.3,
      Math.min(2.5, transformRef.current.k * factor)
    );
  };

  const zoomBy = (factor: number) => {
    transformRef.current.k = Math.max(
      0.3,
      Math.min(2.5, transformRef.current.k * factor)
    );
  };

  const resetView = () => {
    transformRef.current = { x: -160, y: 12, k: 0.9 };
  };

  return (
    <div className="relative w-full h-full select-none overflow-hidden">
      <canvas
        ref={canvasRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
        className="w-full h-full cursor-grab active:cursor-grabbing block"
      />

      {/* Floating Apple Glass Legend Capsule (Bottom Left) */}
      <div className="fixed bottom-5 left-6 z-20 apple-glass rounded-2xl px-4 py-3 pointer-events-none">
        <div className="flex items-center gap-2 text-[11px] font-medium text-[#1D1D1F] mb-1.5">
          <span>Creativity Score = out_degree / in_degree</span>
          <span className="text-[#86868B] font-normal">
            · Click any node to make it the Seed Paper
          </span>
        </div>
        <div className="flex items-center gap-4 text-[11px] text-[#86868B]">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-[#1D1D1F] inline-block" />
            Seed Paper
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full border-2 border-[#D97757] bg-white inline-block" />
            Landmark (≥ 25)
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full border-2 border-[#0071E3] bg-white inline-block" />
            Amplifier (10–25)
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full border-2 border-[#86868B] bg-white inline-block" />
            Foundation
          </span>
        </div>
      </div>

      {/* Floating Apple Glass Hover Preview */}
      {hoveredNode && (
        <div className="fixed top-20 left-6 z-20 apple-glass rounded-2xl p-3.5 max-w-xs pointer-events-none transition-all">
          <div className="text-[10px] uppercase tracking-wider text-[#0071E3] font-medium mb-0.5">
            {hoveredNode.id === seedId
              ? 'Current Seed Paper'
              : 'Click to set as New Seed Paper'}
          </div>
          <div className="font-serif-editorial text-sm font-medium text-[#1D1D1F] leading-snug">
            {hoveredNode.title}
          </div>
          <div className="text-[11px] text-[#86868B] mt-0.5">
            {hoveredNode.authors.join(', ')}{' '}
            {hoveredNode.year ? `(${hoveredNode.year})` : ''}
          </div>
          <div className="flex items-center gap-2.5 mt-2.5 pt-2 border-t border-black/[0.06] font-mono-metric text-[11px] text-[#1D1D1F]">
            <span>Out: {getActualOutDegree(hoveredNode)}</span>
            <span className="text-black/20">/</span>
            <span>In: {getActualInDegree(hoveredNode)}</span>
            <span className="ml-auto font-medium text-[#D97757]">
              = {hoveredNode.creativity_score.toFixed(2)}
            </span>
          </div>
        </div>
      )}

      {/* Floating Apple Glass Zoom Capsule */}
      <div className="fixed bottom-5 right-[400px] z-20 apple-glass rounded-full p-1 flex items-center gap-0.5">
        <button
          onClick={() => zoomBy(1.18)}
          title="Zoom In"
          className="p-2 hover:bg-black/[0.05] rounded-full text-[#86868B] hover:text-[#1D1D1F] transition"
        >
          <ZoomIn className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => zoomBy(0.84)}
          title="Zoom Out"
          className="p-2 hover:bg-black/[0.05] rounded-full text-[#86868B] hover:text-[#1D1D1F] transition"
        >
          <ZoomOut className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={resetView}
          title="Center View"
          className="p-2 hover:bg-black/[0.05] rounded-full text-[#86868B] hover:text-[#1D1D1F] transition"
        >
          <Maximize2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};
