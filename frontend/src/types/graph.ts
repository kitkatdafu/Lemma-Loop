export interface PaperNode {
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  doi_url: string | null;
  pdf_url: string | null;
  google_scholar_url: string;
  google_scholar_cited_by_url: string;
  openalex_id: string | null;
  abstract_snippet: string | null;
  signed_level: number;
  bfs_level: number;
  in_degree: number;
  out_degree: number;
  global_references_count: number;
  global_citations_count: number;
  creativity_score: number;
  smoothed_creativity_score: number;
  global_creativity_score: number;
  expanded: boolean;
}

export interface CitationEdge {
  id: string;
  source: string;
  target: string;
  level_discovered: number;
}

export interface NodeMetricsUpdate {
  id: string;
  in_degree: number;
  out_degree: number;
  global_references_count: number;
  global_citations_count: number;
  creativity_score: number;
  smoothed_creativity_score: number;
  global_creativity_score: number;
  expanded: boolean;
}

export interface GraphSnapshot {
  seed_id: string;
  nodes: PaperNode[];
  edges: CitationEdge[];
  current_level: number;
  max_levels: number;
  status: string;
}

export type GraphEvent =
  | {
      type: 'session_initialized';
      session_id: string;
      snapshot: GraphSnapshot;
    }
  | {
      type: 'level_started';
      level: number;
      frontier_ids: string[];
    }
  | {
      type: 'node_expanding';
      node_id: string;
      title: string;
      level: number;
    }
  | {
      type: 'node_expanded';
      center_id: string;
      level: number;
      new_nodes: PaperNode[];
      new_edges: CitationEdge[];
      updated_metrics: NodeMetricsUpdate[];
    }
  | {
      type: 'level_completed';
      level: number;
      total_nodes: number;
      total_edges: number;
    }
  | {
      type: 'status_changed';
      status: string;
      message: string;
    }
  | {
      type: 'error';
      message: string;
    };

export type CreativityMode = 'actual' | 'smoothed' | 'subgraph';
export type LayoutMode = 'level_flow' | 'force_radial';
