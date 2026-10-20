use crate::models::{
    build_google_scholar_cited_by_url, build_google_scholar_url, compute_creativity_ratio,
    PaperNode,
};
use crate::seed_data::{
    curated_secondary_neighbors, zhang_2014_citations, zhang_2014_references, zhang_2014_seed_node,
};
use reqwest::Client;
use serde::Deserialize;
use std::time::Duration;
use tracing::{info, warn};

#[derive(Clone)]
pub struct PaperProvider {
    client: Client,
}

#[derive(Debug, Deserialize)]
struct OpenAlexListResponse {
    results: Vec<OpenAlexWork>,
}

#[derive(Debug, Deserialize, Clone)]
struct OpenAlexWork {
    id: String,
    title: Option<String>,
    display_name: Option<String>,
    publication_year: Option<u32>,
    doi: Option<String>,
    cited_by_count: Option<usize>,
    referenced_works: Option<Vec<String>>,
    authorships: Option<Vec<OpenAlexAuthorship>>,
    primary_location: Option<OpenAlexLocation>,
    open_access: Option<OpenAlexOpenAccess>,
}

#[derive(Debug, Deserialize, Clone)]
struct OpenAlexAuthorship {
    author: Option<OpenAlexAuthor>,
}

#[derive(Debug, Deserialize, Clone)]
struct OpenAlexAuthor {
    display_name: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
struct OpenAlexLocation {
    source: Option<OpenAlexSource>,
    pdf_url: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
struct OpenAlexSource {
    display_name: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
struct OpenAlexOpenAccess {
    oa_url: Option<String>,
}

#[derive(Debug, Default, Clone)]
pub struct ScholarScrapedMeta {
    pub title: String,
    pub cited_by_count: Option<usize>,
    pub year: Option<u32>,
}

impl PaperProvider {
    pub fn new() -> Self {
        let client = Client::builder()
            .user_agent("LemmaLoop-MathKnowledgeGraph/0.1 (mailto:research@lemmaloop.org)")
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_else(|_| Client::new());
        Self { client }
    }

    /// Extracts a clean paper search query (and any Google Scholar citation count)
    /// from a Google Scholar URL, DOI URL, or raw paper title.
    pub async fn normalize_input_query(&self, raw_query: &str) -> ScholarScrapedMeta {
        let trimmed = Self::strip_bidi_controls(raw_query.trim());

        // 1. Handle Google Scholar URLs (e.g. https://scholar.google.com/scholar?q=... or citations?view_op=view_citation...)
        if trimmed.contains("scholar.google.") {
            if let Ok(parsed) = url::Url::parse(&trimmed) {
                for (k, v) in parsed.query_pairs() {
                    if k == "q" || k == "as_epq" || k == "as_oq" {
                        let cleaned = Self::strip_bidi_controls(&v)
                            .trim()
                            .trim_matches('"')
                            .replace("related:", "")
                            .replace("info:", "")
                            .trim()
                            .to_string();
                        if !cleaned.is_empty() && !cleaned.contains(':') {
                            return ScholarScrapedMeta {
                                title: cleaned,
                                cited_by_count: None,
                                year: None,
                            };
                        }
                    }
                }
            }

            // Fetch the Google Scholar page HTML and extract clean title + "Cited by X" count
            if let Ok(resp) = self
                .client
                .get(&trimmed)
                .header(
                    "User-Agent",
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                )
                .send()
                .await
            {
                if let Ok(html) = resp.text().await {
                    if let Some(meta) = Self::extract_meta_from_scholar_html(&html) {
                        return meta;
                    }
                }
            }
        }

        ScholarScrapedMeta {
            title: trimmed,
            cited_by_count: None,
            year: None,
        }
    }

    fn strip_bidi_controls(s: &str) -> String {
        s.chars()
            .filter(|&c| {
                !matches!(
                    c,
                    '\u{200E}'
                        | '\u{200F}'
                        | '\u{202A}'
                        | '\u{202B}'
                        | '\u{202C}'
                        | '\u{202D}'
                        | '\u{202E}'
                        | '\u{2066}'
                        | '\u{2067}'
                        | '\u{2068}'
                        | '\u{2069}'
                        | '\u{FEFF}'
                )
            })
            .collect()
    }

    fn extract_meta_from_scholar_html(html: &str) -> Option<ScholarScrapedMeta> {
        let mut title_opt: Option<String> = None;
        let mut cited_by_count: Option<usize> = None;

        // Parse `<meta property="og:description" content="... - Cited by 91,273">` or `<meta name="description" ...>`
        for marker in ["property=\"og:description\"", "name=\"description\""] {
            if let Some(idx) = html.find(marker) {
                let after = &html[idx..];
                if let Some(c_idx) = after.find("content=\"") {
                    let val_start = &after[c_idx + 9..];
                    if let Some(end_q) = val_start.find('"') {
                        let desc = Self::strip_bidi_controls(&val_start[..end_q]);
                        if let Some(cited_idx) = desc.find("Cited by ") {
                            let num_part = &desc[cited_idx + 9..];
                            let digits: String = num_part
                                .chars()
                                .take_while(|c| c.is_ascii_digit() || *c == ',')
                                .filter(|c| c.is_ascii_digit())
                                .collect();
                            if let Ok(n) = digits.parse::<usize>() {
                                cited_by_count = Some(n);
                                break;
                            }
                        }
                    }
                }
            }
        }

        // Check `<meta property="og:title" content="...">`
        if let Some(idx) = html.find("property=\"og:title\"") {
            let after = &html[idx..];
            if let Some(c_idx) = after.find("content=\"") {
                let val_start = &after[c_idx + 9..];
                if let Some(end_q) = val_start.find('"') {
                    let raw_title = Self::strip_bidi_controls(&val_start[..end_q])
                        .trim()
                        .to_string();
                    if !raw_title.is_empty() && !raw_title.to_lowercase().contains("google scholar")
                    {
                        title_opt = Some(raw_title);
                    }
                }
            }
        }

        // Fallback to first search result heading `<h3 class="gs_rt"...>`
        if title_opt.is_none() {
            if let Some(idx) = html.find("class=\"gs_rt\"") {
                let after = &html[idx..];
                if let Some(close_bracket) = after.find('>') {
                    let inner = &after[close_bracket + 1..];
                    if let Some(end_h3) = inner.find("</h3>") {
                        let raw_fragment = &inner[..end_h3];
                        let stripped = Self::strip_html_tags(raw_fragment);
                        let cleaned = Self::strip_bidi_controls(&stripped)
                            .replace("[PDF]", "")
                            .replace("[HTML]", "")
                            .replace("[BOOK]", "")
                            .replace("[B]", "")
                            .trim()
                            .to_string();
                        if !cleaned.is_empty() {
                            title_opt = Some(cleaned);
                        }
                    }
                }
            }
        }

        title_opt.map(|title| ScholarScrapedMeta {
            title,
            cited_by_count,
            year: None,
        })
    }

    fn strip_html_tags(input: &str) -> String {
        let mut out = String::with_capacity(input.len());
        let mut in_tag = false;
        for ch in input.chars() {
            match ch {
                '<' => in_tag = true,
                '>' => in_tag = false,
                _ if !in_tag => out.push(ch),
                _ => {}
            }
        }
        out
    }

    /// Resolves a paper query (title, Google Scholar URL, or DOI/ID) into a canonical `PaperNode`.
    /// Special-cases "Bounded gaps between primes" so it always has exact curated metadata
    /// from Yitang Zhang's 2014 Annals of Mathematics paper, enriched by live OpenAlex data if online.
    pub async fn resolve_seed_paper(&self, raw_query: &str) -> PaperNode {
        let scraped = self.normalize_input_query(raw_query).await;
        let query = scraped.title.as_str();
        let normalized = query.trim().to_lowercase();
        if normalized.contains("bounded gaps between primes")
            || normalized == "w2052126598"
            || normalized.is_empty()
        {
            let mut seed = zhang_2014_seed_node();
            // Try to enrich global citation count from OpenAlex if online
            if let Some(live) = self.fetch_openalex_work_by_id("W2052126598").await {
                if let Some(cites) = live.cited_by_count {
                    if cites > seed.global_citations_count {
                        seed.global_citations_count = cites;
                    }
                }
                if let Some(refs) = &live.referenced_works {
                    if refs.len() > seed.global_references_count {
                        seed.global_references_count = refs.len();
                    }
                }
            }
            if let Some(gs_cites) = scraped.cited_by_count {
                if gs_cites > seed.global_citations_count {
                    seed.global_citations_count = gs_cites;
                }
            }
            seed.recompute_creativity();
            return seed;
        }

        // Check if query matches any curated paper by title or ID
        let mut all_curated = zhang_2014_references();
        all_curated.extend(zhang_2014_citations());
        for parent_id in ["W2040968098", "W2163801122", "W2075617843", "W2145920144"] {
            let (sec_in, sec_out) = curated_secondary_neighbors(parent_id);
            all_curated.extend(sec_in);
            all_curated.extend(sec_out);
        }
        for candidate in all_curated {
            let cand_title_lower = candidate.title.to_lowercase();
            if candidate.id.eq_ignore_ascii_case(query.trim())
                || cand_title_lower == normalized
                || (normalized.len() > 8 && normalized.contains(&cand_title_lower))
            {
                let mut node = candidate;
                node.signed_level = 0;
                node.bfs_level = 0;
                if raw_query.trim().contains("scholar.google.") {
                    node.google_scholar_url = raw_query.trim().to_string();
                }
                if let Some(gs_cites) = scraped.cited_by_count {
                    if gs_cites > node.global_citations_count {
                        node.global_citations_count = gs_cites;
                    }
                }
                node.recompute_creativity();
                return node;
            }
        }

        // If query is an OpenAlex ID (e.g., W2163801122), fetch directly by ID
        if query.trim().starts_with('W') && query.trim()[1..].chars().all(|c| c.is_ascii_digit()) {
            if let Some(work) = self.fetch_openalex_work_by_id(query.trim()).await {
                return Self::openalex_to_node(work, 0, 0);
            }
        }

        // Query OpenAlex live search and pick the canonical edition with the richest bibliography + citations
        let url = format!(
            "https://api.openalex.org/works?search={}&per-page=10",
            urlencoding::encode(query.trim())
        );
        if let Ok(resp) = self.client.get(&url).send().await {
            if let Ok(list) = resp.json::<OpenAlexListResponse>().await {
                let best_work = list.results.into_iter().max_by_key(|w| {
                    let w_title = w
                        .title
                        .as_deref()
                        .or(w.display_name.as_deref())
                        .unwrap_or("")
                        .trim()
                        .to_lowercase();
                    let exact_title_bonus: usize = if w_title == normalized {
                        1_000_000
                    } else if w_title.contains(&normalized) || normalized.contains(&w_title) {
                        200_000
                    } else {
                        0
                    };
                    let refs_len = w.referenced_works.as_ref().map(|r| r.len()).unwrap_or(0);
                    let has_refs_bonus: usize = if refs_len > 0 { 500_000 } else { 0 };
                    let cites = w.cited_by_count.unwrap_or(0);
                    exact_title_bonus + has_refs_bonus + cites + refs_len * 100
                });

                if let Some(work) = best_work {
                    let mut node = Self::openalex_to_node(work, 0, 0);
                    if raw_query.trim().contains("scholar.google.") {
                        node.google_scholar_url = raw_query.trim().to_string();
                    }
                    if let Some(gs_cites) = scraped.cited_by_count {
                        if gs_cites > node.global_citations_count {
                            node.global_citations_count = gs_cites;
                        }
                    }
                    node.recompute_creativity();
                    return node;
                }
            }
        }

        warn!(
            "Falling back to synthetic seed node for query '{}' (offline or not found)",
            query
        );
        let authors = vec!["Unknown Author".to_string()];
        PaperNode {
            id: format!("seed-{}", uuid::Uuid::new_v4()),
            title: query.trim().to_string(),
            google_scholar_url: build_google_scholar_url(query.trim(), &authors),
            google_scholar_cited_by_url: build_google_scholar_cited_by_url(query.trim()),
            authors,
            year: Some(2024),
            venue: Some("Mathematical Literature".to_string()),
            doi_url: None,
            pdf_url: None,
            openalex_id: None,
            abstract_snippet: Some(format!("Seed paper node resolved from query '{}'.", query)),
            signed_level: 0,
            bfs_level: 0,
            in_degree: 0,
            out_degree: 0,
            global_references_count: 15,
            global_citations_count: 45,
            creativity_score: 0.0,
            smoothed_creativity_score: 1.0,
            global_creativity_score: 3.0,
            expanded: false,
        }
    }

    /// Fetches both In-Nodes (References `u -> center`) and Out-Nodes (Citations `center -> w`)
    /// in parallel using `tokio::join!`.
    pub async fn fetch_neighbors_parallel(
        &self,
        center: &PaperNode,
        next_bfs_level: u32,
        top_k_in: usize,
        top_k_out: usize,
    ) -> (Vec<PaperNode>, Vec<PaperNode>) {
        info!(
            "Fetching in-nodes (references) and out-nodes (citations) in parallel for '{}' ({})",
            center.title, center.id
        );

        let in_signed_level = if center.signed_level <= 0 {
            center.signed_level - 1
        } else {
            center.signed_level - 1
        };
        let out_signed_level = if center.signed_level >= 0 {
            center.signed_level + 1
        } else {
            center.signed_level + 1
        };

        let (in_nodes, out_nodes) = tokio::join!(
            self.fetch_in_nodes(center, in_signed_level, next_bfs_level, top_k_in),
            self.fetch_out_nodes(center, out_signed_level, next_bfs_level, top_k_out)
        );

        (in_nodes, out_nodes)
    }

    /// Fetches In-Nodes (`u -> center`): papers referenced by `center`.
    pub async fn fetch_in_nodes(
        &self,
        center: &PaperNode,
        signed_level: i32,
        bfs_level: u32,
        top_k: usize,
    ) -> Vec<PaperNode> {
        let mut results: Vec<PaperNode> = Vec::new();

        // 1. If this is Yitang Zhang's "Bounded gaps between primes", always include the curated PDF references first!
        if center.id == "W2052126598"
            || center
                .title
                .to_lowercase()
                .contains("bounded gaps between primes")
        {
            for mut r in zhang_2014_references() {
                r.signed_level = signed_level;
                r.bfs_level = bfs_level;
                results.push(r);
            }
        } else {
            // Check curated secondary neighbor store
            let (curated_in, _) = curated_secondary_neighbors(&center.id);
            for mut r in curated_in {
                r.signed_level = signed_level;
                r.bfs_level = bfs_level;
                results.push(r);
            }
        }

        // 2. Also query OpenAlex live referenced_works if we have budget left in `top_k`
        if results.len() < top_k {
            let short_id = Self::short_openalex_id(&center.id);
            if short_id.starts_with('W') {
                if let Some(work) = self.fetch_openalex_work_by_id(&short_id).await {
                    if let Some(ref_urls) = work.referenced_works {
                        let ref_ids: Vec<String> = ref_urls
                            .into_iter()
                            .map(|u| Self::short_openalex_id(&u))
                            .filter(|id| id.starts_with('W'))
                            .take(top_k.min(25))
                            .collect();

                        if !ref_ids.is_empty() {
                            let filter = ref_ids.join("|");
                            let batch_url = format!(
                                "https://api.openalex.org/works?filter=openalex_id:{}&per-page={}",
                                filter,
                                top_k.min(25)
                            );
                            if let Ok(resp) = self.client.get(&batch_url).send().await {
                                if let Ok(list) = resp.json::<OpenAlexListResponse>().await {
                                    for w in list.results {
                                        let node = Self::openalex_to_node(w, signed_level, bfs_level);
                                        if !results.iter().any(|existing| {
                                            existing.id == node.id
                                                || existing.title.eq_ignore_ascii_case(&node.title)
                                        }) {
                                            results.push(node);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // Sort in-nodes by global citations descending and truncate to `top_k`
        results.sort_by(|a, b| b.global_citations_count.cmp(&a.global_citations_count));
        results.truncate(top_k);
        results
    }

    /// Fetches Out-Nodes (`center -> w`): papers that cite `center`.
    pub async fn fetch_out_nodes(
        &self,
        center: &PaperNode,
        signed_level: i32,
        bfs_level: u32,
        top_k: usize,
    ) -> Vec<PaperNode> {
        let mut results: Vec<PaperNode> = Vec::new();

        // 1. If this is Yitang Zhang's "Bounded gaps between primes", seed with curated landmark citing works
        if center.id == "W2052126598"
            || center
                .title
                .to_lowercase()
                .contains("bounded gaps between primes")
        {
            for mut c in zhang_2014_citations() {
                c.signed_level = signed_level;
                c.bfs_level = bfs_level;
                results.push(c);
            }
        } else {
            let (_, curated_out) = curated_secondary_neighbors(&center.id);
            for mut c in curated_out {
                c.signed_level = signed_level;
                c.bfs_level = bfs_level;
                results.push(c);
            }
        }

        // 2. Query OpenAlex live `cites:{id}` sorted by `cited_by_count:desc`
        let short_id = Self::short_openalex_id(&center.id);
        if short_id.starts_with('W') {
            let cites_url = format!(
                "https://api.openalex.org/works?filter=cites:{}&sort=cited_by_count:desc&per-page={}",
                short_id,
                top_k.min(25)
            );
            if let Ok(resp) = self.client.get(&cites_url).send().await {
                if let Ok(list) = resp.json::<OpenAlexListResponse>().await {
                    for w in list.results {
                        let node = Self::openalex_to_node(w, signed_level, bfs_level);
                        if !results.iter().any(|existing| {
                            existing.id == node.id
                                || existing.title.eq_ignore_ascii_case(&node.title)
                        }) {
                            results.push(node);
                        }
                    }
                }
            }
        }

        results.sort_by(|a, b| b.global_citations_count.cmp(&a.global_citations_count));
        results.truncate(top_k);
        results
    }

    async fn fetch_openalex_work_by_id(&self, short_id: &str) -> Option<OpenAlexWork> {
        let url = format!("https://api.openalex.org/works/{}", short_id);
        let resp = self.client.get(&url).send().await.ok()?;
        if !resp.status().is_success() {
            return None;
        }
        resp.json::<OpenAlexWork>().await.ok()
    }

    fn short_openalex_id(raw: &str) -> String {
        raw.rsplit('/').next().unwrap_or(raw).to_string()
    }

    fn openalex_to_node(work: OpenAlexWork, signed_level: i32, bfs_level: u32) -> PaperNode {
        let short_id = Self::short_openalex_id(&work.id);
        let title = work
            .title
            .or(work.display_name)
            .unwrap_or_else(|| format!("Paper {}", short_id));

        let authors: Vec<String> = work
            .authorships
            .unwrap_or_default()
            .into_iter()
            .filter_map(|a| a.author.and_then(|au| au.display_name))
            .take(5)
            .collect();

        let venue = work
            .primary_location
            .as_ref()
            .and_then(|loc| loc.source.as_ref())
            .and_then(|src| src.display_name.clone());

        let pdf_url = work
            .primary_location
            .and_then(|loc| loc.pdf_url)
            .or_else(|| work.open_access.and_then(|oa| oa.oa_url));

        let global_references_count = work
            .referenced_works
            .as_ref()
            .map(|r| r.len())
            .unwrap_or(0);
        let global_citations_count = work.cited_by_count.unwrap_or(0);

        let gs_url = build_google_scholar_url(&title, &authors);
        let gs_cited_url = build_google_scholar_cited_by_url(&title);

        let mut node = PaperNode {
            id: short_id,
            title,
            authors,
            year: work.publication_year,
            venue,
            doi_url: work.doi,
            pdf_url,
            google_scholar_url: gs_url,
            google_scholar_cited_by_url: gs_cited_url,
            openalex_id: Some(work.id),
            abstract_snippet: None,
            signed_level,
            bfs_level,
            in_degree: 0,
            out_degree: 0,
            global_references_count,
            global_citations_count,
            creativity_score: 0.0,
            smoothed_creativity_score: 1.0,
            global_creativity_score: 0.0,
            expanded: false,
        };
        node.recompute_creativity();
        node
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_google_scholar_url_parsing() {
        let provider = PaperProvider::new();
        let gs_url = "https://scholar.google.com/scholar?hl=en&as_sdt=0%2C5&q=%22Small+gaps+between+primes%22+James+Maynard&btnG=";
        let normalized = provider.normalize_input_query(gs_url).await;
        assert!(normalized.title.to_lowercase().contains("small gaps between primes"));

        let resolved = provider.resolve_seed_paper(gs_url).await;
        assert_eq!(resolved.id, "W2163801122");
        assert_eq!(resolved.title, "Small gaps between primes");
        assert_eq!(resolved.google_scholar_url, gs_url);
    }
}

