import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  CitationEdge,
  CreativityMode,
  GraphEvent,
  GraphSnapshot,
  LayoutMode,
  PaperNode,
} from './types/graph';
import { ControlBar } from './components/ControlBar';
import { GraphCanvas } from './components/GraphCanvas';
import { NodeInspector } from './components/NodeInspector';

export const App: React.FC = () => {
  const [query, setQuery] = useState<string>('Bounded gaps between primes');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [seedId, setSeedId] = useState<string>('W2052126598');
  const [nodes, setNodes] = useState<PaperNode[]>([]);
  const [edges, setEdges] = useState<CitationEdge[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(
    'W2052126598'
  );
  const [expandingNodeIds, setExpandingNodeIds] = useState<Set<string>>(
    new Set()
  );

  const [status, setStatus] = useState<string>('ready');
  const [statusMessage, setStatusMessage] = useState<string>(
    'Loaded Zhang (2014) Bounded gaps between primes graph'
  );
  const [currentLevel, setCurrentLevel] = useState<number>(1);
  const [maxLevels, setMaxLevels] = useState<number>(1);
  const [topKIn, setTopKIn] = useState<number>(12);
  const [topKOut, setTopKOut] = useState<number>(12);

  const [creativityMode, setCreativityMode] =
    useState<CreativityMode>('actual');
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('level_flow');

  const eventSourceRef = useRef<EventSource | null>(null);

  const closeEventSource = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  };

  const applySnapshot = useCallback((snap: GraphSnapshot) => {
    setSeedId(snap.seed_id);
    setNodes(snap.nodes);
    setEdges(snap.edges);
    setCurrentLevel(snap.current_level);
    setStatus(snap.status);
    setSelectedNodeId((prev) =>
      snap.nodes.some((n) => n.id === prev) ? prev : snap.seed_id
    );
  }, []);

  const loadZhangPreset = useCallback(async () => {
    closeEventSource();
    setSessionId(null);
    setExpandingNodeIds(new Set());
    try {
      const resp = await fetch('/api/preset/zhang2014');
      if (!resp.ok) throw new Error('Failed to fetch preset');
      const snap: GraphSnapshot = await resp.json();
      setQuery('Bounded gaps between primes');
      applySnapshot(snap);
      setStatusMessage(
        'Loaded Yitang Zhang (2014) "Bounded gaps between primes" — Click "Grow Online" or "+1 Level" to expand live!'
      );
    } catch (err) {
      console.error('Error loading preset:', err);
      setStatusMessage('Backend connecting on port 3001...');
    }
  }, [applySnapshot]);

  // Load Zhang (2014) curated graph immediately on mount, then automatically start online level growth!
  useEffect(() => {
    loadZhangPreset();
    return () => closeEventSource();
  }, [loadZhangPreset]);

  const connectSessionStream = useCallback(
    (id: string) => {
      closeEventSource();
      const es = new EventSource(`/api/session/${id}/stream`);
      eventSourceRef.current = es;

      es.onmessage = (e) => {
        if (!e.data || e.data === 'keep-alive') return;
        try {
          const ev: GraphEvent = JSON.parse(e.data);
          switch (ev.type) {
            case 'session_initialized': {
              applySnapshot(ev.snapshot);
              break;
            }
            case 'level_started': {
              setStatus('running');
              setStatusMessage(
                `Growing Level ${ev.level} in parallel (${ev.frontier_ids.length} frontier papers)...`
              );
              break;
            }
            case 'node_expanding': {
              setExpandingNodeIds((prev) => {
                const next = new Set(prev);
                next.add(ev.node_id);
                return next;
              });
              setStatusMessage(
                `Level ${ev.level}: Fetching In-Nodes (References) & Out-Nodes (Citations) in parallel for "${ev.title}"...`
              );
              break;
            }
            case 'node_expanded': {
              setExpandingNodeIds((prev) => {
                const next = new Set(prev);
                next.delete(ev.center_id);
                return next;
              });

              setNodes((prevNodes) => {
                const map = new Map<string, PaperNode>();
                for (const n of prevNodes) {
                  map.set(n.id, { ...n });
                }
                for (const newNode of ev.new_nodes) {
                  map.set(newNode.id, newNode);
                }
                for (const m of ev.updated_metrics) {
                  const existing = map.get(m.id);
                  if (existing) {
                    existing.in_degree = m.in_degree;
                    existing.out_degree = m.out_degree;
                    existing.global_references_count =
                      m.global_references_count;
                    existing.global_citations_count = m.global_citations_count;
                    existing.creativity_score = m.creativity_score;
                    existing.smoothed_creativity_score =
                      m.smoothed_creativity_score;
                    existing.global_creativity_score =
                      m.global_creativity_score;
                    existing.expanded = m.expanded;
                  }
                }
                return Array.from(map.values());
              });

              setEdges((prevEdges) => {
                const edgeMap = new Map<string, CitationEdge>();
                for (const edge of prevEdges) {
                  edgeMap.set(edge.id, edge);
                }
                for (const newEdge of ev.new_edges) {
                  edgeMap.set(newEdge.id, newEdge);
                }
                return Array.from(edgeMap.values());
              });
              break;
            }
            case 'level_completed': {
              setCurrentLevel(ev.level);
              setStatusMessage(
                `Completed Level ${ev.level} (${ev.total_nodes} nodes, ${ev.total_edges} directed edges)`
              );
              break;
            }
            case 'status_changed': {
              setStatus(ev.status);
              setStatusMessage(ev.message);
              if (ev.status !== 'running') {
                setExpandingNodeIds(new Set());
              }
              break;
            }
            case 'error': {
              setStatusMessage(`Notice: ${ev.message}`);
              break;
            }
          }
        } catch (err) {
          console.error('Failed to parse SSE GraphEvent:', err);
        }
      };

      es.onerror = () => {
        // Keep current graph intact if stream ends
      };
    },
    [applySnapshot]
  );

  const handleStartLiveExpansion = async (customQuery?: string) => {
    const targetQuery = (customQuery ?? query).trim() || 'Bounded gaps between primes';
    setStatus('running');
    setStatusMessage(`Starting online parallel expansion for "${targetQuery}"...`);

    try {
      const resp = await fetch('/api/session/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: targetQuery,
          max_levels: maxLevels,
          top_k_in: topKIn,
          top_k_out: topKOut,
          auto_run: true,
        }),
      });
      if (!resp.ok) throw new Error('Failed to start expansion session');
      const data: { session_id: string; snapshot: GraphSnapshot } =
        await resp.json();
      setSessionId(data.session_id);
      applySnapshot(data.snapshot);
      const seedNode = data.snapshot.nodes.find(
        (n) => n.id === data.snapshot.seed_id
      );
      if (seedNode) {
        setQuery(seedNode.title);
      }
      setSelectedNodeId(data.snapshot.seed_id);
      connectSessionStream(data.session_id);
    } catch (err) {
      console.error('Error starting live expansion:', err);
      setStatus('ready');
      setStatusMessage('Error starting session — check backend connection.');
    }
  };

  const handleControlSession = async (
    action: 'pause' | 'resume' | 'step' | 'stop'
  ) => {
    if (!sessionId) {
      // If user clicked "+1 Level" while viewing the initial preset, start a session and step
      await handleStartLiveExpansion(query);
      return;
    }
    try {
      await fetch(`/api/session/${sessionId}/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
    } catch (err) {
      console.error('Error sending session control:', err);
    }
  };

  const handleExpandNode = async (nodeId: string) => {
    if (!sessionId) {
      // Start a session first if none active
      const resp = await fetch('/api/session/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          max_levels: maxLevels,
          top_k_in: topKIn,
          top_k_out: topKOut,
          auto_run: false,
        }),
      });
      if (resp.ok) {
        const data: { session_id: string; snapshot: GraphSnapshot } =
          await resp.json();
        setSessionId(data.session_id);
        connectSessionStream(data.session_id);
        await fetch(`/api/session/${data.session_id}/expand-node`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            node_id: nodeId,
            top_k_in: topKIn,
            top_k_out: topKOut,
          }),
        });
      }
      return;
    }

    try {
      await fetch(`/api/session/${sessionId}/expand-node`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          node_id: nodeId,
          top_k_in: topKIn,
          top_k_out: topKOut,
        }),
      });
    } catch (err) {
      console.error('Error expanding node:', err);
    }
  };

  // When clicking any node, it becomes the new seed paper!
  const handleSelectNodeAsNewSeed = async (nodeId: string) => {
    setSelectedNodeId(nodeId);
    if (nodeId === seedId) return;

    const clickedNode = nodes.find((n) => n.id === nodeId);
    const seedQuery = clickedNode ? clickedNode.id : nodeId;
    if (clickedNode) {
      setQuery(clickedNode.title);
    }

    await handleStartLiveExpansion(seedQuery);
  };

  return (
    <div className="relative w-screen h-screen bg-[#F5F5F7] text-[#1D1D1F] overflow-hidden">
      <ControlBar
        query={query}
        onQueryChange={setQuery}
        status={status}
        currentLevel={currentLevel}
        maxLevels={maxLevels}
        onMaxLevelsChange={setMaxLevels}
        topKIn={topKIn}
        onTopKInChange={setTopKIn}
        topKOut={topKOut}
        onTopKOutChange={setTopKOut}
        creativityMode={creativityMode}
        onCreativityModeChange={setCreativityMode}
        layoutMode={layoutMode}
        onLayoutModeChange={setLayoutMode}
        onStartLiveExpansion={handleStartLiveExpansion}
        onControlSession={handleControlSession}
        onResetToZhangPreset={loadZhangPreset}
        nodeCount={nodes.length}
        edgeCount={edges.filter((e) => e.source === seedId || e.target === seedId).length}
        statusMessage={statusMessage}
      />

      <main className="w-full h-full relative">
        <GraphCanvas
          nodes={nodes}
          edges={edges}
          seedId={seedId}
          selectedNodeId={selectedNodeId}
          expandingNodeIds={expandingNodeIds}
          creativityMode={creativityMode}
          layoutMode={layoutMode}
          onSelectNode={handleSelectNodeAsNewSeed}
          onDoubleClickNode={handleSelectNodeAsNewSeed}
        />

        <NodeInspector
          nodes={nodes}
          edges={edges}
          seedId={seedId}
          selectedNodeId={selectedNodeId}
          expandingNodeIds={expandingNodeIds}
          creativityMode={creativityMode}
          onSelectNode={handleSelectNodeAsNewSeed}
          onExpandNode={handleExpandNode}
        />
      </main>
    </div>
  );
};

export default App;
