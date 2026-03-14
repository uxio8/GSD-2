//! GSD `.gsd/` directory file parser.
//!
//! Parses markdown files containing YAML-like frontmatter, section headings,
//! and structured content used by GSD's planning system (roadmaps, plans,
//! summaries, continue files).
//!
//! Key operations:
//! - `parseFrontmatter`: split frontmatter from body, parse YAML-like key-value pairs
//! - `extractSection`: extract content under a specific heading
//! - `batchParseGsdFiles`: walk a `.gsd/` tree and parse all `.md` files in parallel
//! - `parseRoadmapFile`: parse structured roadmap data from content

use std::path::Path;

use napi::bindgen_prelude::*;
use napi_derive::napi;

// ─── Frontmatter Parsing ────────────────────────────────────────────────────

/// Result of splitting a markdown file into frontmatter and body.
#[napi(object)]
pub struct FrontmatterResult {
    /// Parsed frontmatter as a JSON-compatible string (serialized HashMap).
    /// Each value is either a string, a JSON array of strings, or a JSON array of objects.
    pub metadata: String,
    /// The body content after the frontmatter block.
    pub body: String,
}

/// Result of extracting a section from markdown content.
#[napi(object)]
pub struct SectionResult {
    /// The section content, or empty string if not found.
    pub content: String,
    /// Whether the section was found.
    pub found: bool,
}

/// A single parsed GSD file from batch parsing.
#[napi(object)]
pub struct ParsedGsdFile {
    /// Relative path from the base directory.
    pub path: String,
    /// Parsed frontmatter as JSON string.
    pub metadata: String,
    /// Body content after frontmatter.
    pub body: String,
    /// Map of section heading -> content, serialized as JSON.
    pub sections: String,
}

/// Batch parse result.
#[napi(object)]
pub struct BatchParseResult {
    /// All parsed files.
    pub files: Vec<ParsedGsdFile>,
    /// Number of files processed.
    pub count: u32,
}

// ─── Roadmap Structures ─────────────────────────────────────────────────────

#[napi(object)]
pub struct NativeRoadmapSlice {
    pub id: String,
    pub title: String,
    pub risk: String,
    pub depends: Vec<String>,
    pub done: bool,
    pub demo: String,
}

#[napi(object)]
pub struct NativeBoundaryMapEntry {
    #[napi(js_name = "fromSlice")]
    pub from_slice: String,
    #[napi(js_name = "toSlice")]
    pub to_slice: String,
    pub produces: String,
    pub consumes: String,
}

#[napi(object)]
pub struct NativeRoadmap {
    pub title: String,
    pub vision: String,
    #[napi(js_name = "successCriteria")]
    pub success_criteria: Vec<String>,
    pub slices: Vec<NativeRoadmapSlice>,
    #[napi(js_name = "boundaryMap")]
    pub boundary_map: Vec<NativeBoundaryMapEntry>,
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/// Split markdown content into frontmatter lines and body.
fn split_frontmatter_internal(content: &str) -> (Option<Vec<&str>>, &str) {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        return (None, content);
    }

    let after_first = match trimmed.find('\n') {
        Some(idx) => idx,
        None => return (None, content),
    };

    let rest = &trimmed[after_first + 1..];
    let end_idx = match rest.find("\n---") {
        Some(idx) => idx,
        None => return (None, content),
    };

    let fm_lines: Vec<&str> = rest[..end_idx].split('\n').collect();
    let body = rest[end_idx + 4..].trim_start_matches('\n');
    (Some(fm_lines), body)
}

/// Represents a parsed frontmatter value.
#[derive(Debug, Clone)]
enum FmValue {
    Scalar(String),
    Array(Vec<FmArrayItem>),
}

#[derive(Debug, Clone)]
enum FmArrayItem {
    Str(String),
    Obj(Vec<(String, String)>),
}

/// Parse YAML-like frontmatter lines into a structured map.
fn parse_frontmatter_map_internal(lines: &[&str]) -> Vec<(String, FmValue)> {
    let mut result: Vec<(String, FmValue)> = Vec::new();
    let mut current_key: Option<String> = None;
    let mut current_array: Option<Vec<FmArrayItem>> = None;
    let mut current_obj: Option<Vec<(String, String)>> = None;

    for line in lines {
        // Nested object property (4-space indent with key: value)
        if line.starts_with("    ") && !line.starts_with("     ") {
            if current_array.is_some() && current_obj.is_some() {
                let rest = line.trim_start();
                if let Some(colon_pos) = rest.find(": ") {
                    let k = &rest[..colon_pos];
                    let v = rest[colon_pos + 2..].trim();
                    if k.chars().all(|c| c.is_alphanumeric() || c == '_') {
                        current_obj.as_mut().unwrap().push((k.to_string(), v.to_string()));
                        continue;
                    }
                } else if rest.ends_with(':') {
                    let k = &rest[..rest.len() - 1];
                    if k.chars().all(|c| c.is_alphanumeric() || c == '_') {
                        current_obj.as_mut().unwrap().push((k.to_string(), String::new()));
                        continue;
                    }
                }
            }
        }

        // Array item (2-space indent)
        if line.starts_with("  - ") && current_key.is_some() {
            // Push pending nested object
            if let Some(obj) = current_obj.take() {
                if !obj.is_empty() {
                    if let Some(ref mut arr) = current_array {
                        arr.push(FmArrayItem::Obj(obj));
                    }
                }
            }

            let val = line[4..].trim();
            if current_array.is_none() {
                current_array = Some(Vec::new());
            }

            // Check if this array item starts a nested object (e.g. "slice: S00")
            if let Some(colon_pos) = val.find(": ") {
                let k = &val[..colon_pos];
                let v = val[colon_pos + 2..].trim();
                if k.chars().all(|c| c.is_alphanumeric() || c == '_') {
                    current_obj = Some(vec![(k.to_string(), v.to_string())]);
                    continue;
                }
            }

            current_array.as_mut().unwrap().push(FmArrayItem::Str(val.to_string()));
            continue;
        }

        // Flush previous key
        if let Some(key) = current_key.take() {
            if let Some(obj) = current_obj.take() {
                if !obj.is_empty() {
                    if let Some(ref mut arr) = current_array {
                        arr.push(FmArrayItem::Obj(obj));
                    }
                }
            }
            if let Some(arr) = current_array.take() {
                result.push((key, FmValue::Array(arr)));
            }
        }

        // Top-level key: value
        let trimmed = line.trim();
        if let Some(colon_pos) = trimmed.find(':') {
            let key_part = &trimmed[..colon_pos];
            if key_part.chars().all(|c| c.is_alphanumeric() || c == '_') && !key_part.is_empty() {
                let val = trimmed[colon_pos + 1..].trim();

                if val.is_empty() || val == "[]" {
                    current_key = Some(key_part.to_string());
                    current_array = Some(Vec::new());
                } else if val.starts_with('[') && val.ends_with(']') {
                    let inner = val[1..val.len() - 1].trim();
                    if inner.is_empty() {
                        result.push((key_part.to_string(), FmValue::Array(Vec::new())));
                    } else {
                        let items: Vec<FmArrayItem> = inner
                            .split(',')
                            .map(|s| FmArrayItem::Str(s.trim().to_string()))
                            .collect();
                        result.push((key_part.to_string(), FmValue::Array(items)));
                    }
                } else {
                    result.push((key_part.to_string(), FmValue::Scalar(val.to_string())));
                }
            }
        }
    }

    // Flush final key
    if let Some(key) = current_key {
        if let Some(obj) = current_obj {
            if !obj.is_empty() {
                if let Some(ref mut arr) = current_array {
                    arr.push(FmArrayItem::Obj(obj));
                }
            }
        }
        if let Some(arr) = current_array {
            result.push((key, FmValue::Array(arr)));
        }
    }

    result
}

/// Serialize frontmatter map to JSON string.
fn fm_to_json(map: &[(String, FmValue)]) -> String {
    let mut out = String::from("{");
    for (i, (key, value)) in map.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push('"');
        json_escape_into(&mut out, key);
        out.push_str("\":");
        match value {
            FmValue::Scalar(s) => {
                out.push('"');
                json_escape_into(&mut out, s);
                out.push('"');
            }
            FmValue::Array(items) => {
                out.push('[');
                for (j, item) in items.iter().enumerate() {
                    if j > 0 {
                        out.push(',');
                    }
                    match item {
                        FmArrayItem::Str(s) => {
                            out.push('"');
                            json_escape_into(&mut out, s);
                            out.push('"');
                        }
                        FmArrayItem::Obj(pairs) => {
                            out.push('{');
                            for (k, (pk, pv)) in pairs.iter().enumerate() {
                                if k > 0 {
                                    out.push(',');
                                }
                                out.push('"');
                                json_escape_into(&mut out, pk);
                                out.push_str("\":\"");
                                json_escape_into(&mut out, pv);
                                out.push('"');
                            }
                            out.push('}');
                        }
                    }
                }
                out.push(']');
            }
        }
    }
    out.push('}');
    out
}

fn json_escape_into(out: &mut String, s: &str) {
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c < '\x20' => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
}

/// Extract the text after a heading at a given level, up to the next heading of same or higher level.
fn extract_section_internal(body: &str, heading: &str, level: u32) -> Option<String> {
    let prefix = "#".repeat(level as usize);
    let search_pattern = format!("{} {}", prefix, heading);

    // Find the heading line
    for (line_start, line) in line_iter(body) {
        let trimmed = line.trim_end();
        if trimmed == search_pattern || trimmed == format!("{} ", search_pattern).trim_end() {
            let start = line_start + line.len();
            // Skip past the newline
            let start = if start < body.len() && body.as_bytes()[start] == b'\n' {
                start + 1
            } else {
                start
            };

            let rest = &body[start..];

            // Find next heading of same or higher level
            let end = find_next_heading(rest, level);
            let section = &rest[..end];
            return Some(section.trim().to_string());
        }
    }
    None
}

/// Iterator over lines with their byte offsets.
fn line_iter(s: &str) -> Vec<(usize, &str)> {
    let mut result = Vec::new();
    let mut start = 0;
    for (i, c) in s.char_indices() {
        if c == '\n' {
            result.push((start, &s[start..i]));
            start = i + 1;
        }
    }
    if start <= s.len() {
        result.push((start, &s[start..]));
    }
    result
}

/// Find the byte offset of the next heading of the given level or higher.
fn find_next_heading(text: &str, level: u32) -> usize {
    for (offset, line) in line_iter(text) {
        let trimmed = line.trim_start();
        if trimmed.starts_with('#') {
            let hash_count = trimmed.chars().take_while(|&c| c == '#').count() as u32;
            if hash_count >= 1 && hash_count <= level && trimmed.len() > hash_count as usize {
                let after_hashes = &trimmed[hash_count as usize..];
                if after_hashes.starts_with(' ') {
                    return offset;
                }
            }
        }
    }
    text.len()
}

/// Extract all sections at a given level, returning heading -> content pairs.
fn extract_all_sections_internal(body: &str, level: u32) -> Vec<(String, String)> {
    let prefix_len = level as usize;
    let mut sections: Vec<(String, usize)> = Vec::new();

    for (offset, line) in line_iter(body) {
        let trimmed = line.trim_start();
        if trimmed.starts_with(&"#".repeat(prefix_len)) {
            let after = &trimmed[prefix_len..];
            if after.starts_with(' ') && !after.starts_with("# ") {
                let heading = after[1..].trim().to_string();
                sections.push((heading, offset + line.len()));
            }
        }
    }

    let mut result = Vec::new();
    for i in 0..sections.len() {
        let start = sections[i].1;
        let start = if start < body.len() && body.as_bytes().get(start) == Some(&b'\n') {
            start + 1
        } else {
            start
        };
        let end = if i + 1 < sections.len() {
            let next_start = sections[i + 1].1;
            find_heading_line_start(body, next_start)
        } else {
            body.len()
        };
        let content = body[start..end].trim().to_string();
        result.push((sections[i].0.clone(), content));
    }

    result
}

fn find_heading_line_start(body: &str, heading_end: usize) -> usize {
    let search_area = &body[..heading_end];
    match search_area.rfind('\n') {
        Some(pos) => pos + 1,
        None => 0,
    }
}

/// Parse bullet list items from a text block.
fn parse_bullets(text: &str) -> Vec<String> {
    text.lines()
        .map(|l| {
            let trimmed = l.trim_start();
            if trimmed.starts_with("- ") || trimmed.starts_with("* ") {
                trimmed[2..].trim().to_string()
            } else {
                trimmed.to_string()
            }
        })
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .collect()
}

/// Extract key: value from bold-prefixed lines like "**Key:** Value"
fn extract_bold_field<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    let pattern = format!("**{}:**", key);
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix(&pattern) {
            return Some(rest.trim());
        }
    }
    None
}

/// Serialize a string->string map section to JSON.
fn sections_to_json(sections: &[(String, String)]) -> String {
    let mut out = String::from("{");
    for (i, (key, value)) in sections.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push('"');
        json_escape_into(&mut out, key);
        out.push_str("\":\"");
        json_escape_into(&mut out, value);
        out.push('"');
    }
    out.push('}');
    out
}

// ─── Roadmap Parsing ────────────────────────────────────────────────────────

fn parse_roadmap_internal(content: &str) -> NativeRoadmap {
    let title = content
        .lines()
        .find(|l| l.starts_with("# "))
        .map(|l| l[2..].trim().to_string())
        .unwrap_or_default();

    let vision = extract_bold_field(content, "Vision")
        .unwrap_or("")
        .to_string();

    let sc_section = extract_section_internal(content, "Success Criteria", 2)
        .or_else(|| {
            let idx = content.find("**Success Criteria:**")?;
            let rest = &content[idx..];
            let next_section = rest.find("\n---");
            let block = &rest[..next_section.unwrap_or(rest.len())];
            let first_newline = block.find('\n')?;
            Some(block[first_newline + 1..].to_string())
        });
    let success_criteria = sc_section
        .map(|s| parse_bullets(&s))
        .unwrap_or_default();

    let slices = parse_roadmap_slices_internal(content);
    let boundary_map = parse_boundary_map_internal(content);

    NativeRoadmap {
        title,
        vision,
        success_criteria,
        slices,
        boundary_map,
    }
}

fn parse_roadmap_slices_internal(content: &str) -> Vec<NativeRoadmapSlice> {
    let slices_section = match content.find("## Slices") {
        Some(idx) => {
            let start = idx + "## Slices".len();
            let rest = &content[start..];
            let rest = rest.trim_start_matches(|c: char| c == '\r' || c == '\n');
            let end = rest.find("\n## ").unwrap_or(rest.len());
            rest[..end].trim_end()
        }
        None => return Vec::new(),
    };

    let mut slices = Vec::new();
    let mut current_slice: Option<NativeRoadmapSlice> = None;

    for line in slices_section.lines() {
        if let Some(slice) = parse_slice_checkbox_line(line) {
            if let Some(prev) = current_slice.take() {
                slices.push(prev);
            }
            current_slice = Some(slice);
            continue;
        }

        if let Some(ref mut s) = current_slice {
            let trimmed = line.trim();
            if trimmed.starts_with('>') {
                let demo = trimmed[1..].trim();
                let demo = if demo.to_lowercase().starts_with("after this:") {
                    demo["after this:".len()..].trim()
                } else {
                    demo
                };
                s.demo = demo.to_string();
            }
        }
    }

    if let Some(s) = current_slice {
        slices.push(s);
    }

    slices
}

fn parse_slice_checkbox_line(line: &str) -> Option<NativeRoadmapSlice> {
    let trimmed = line.trim_start();
    if !trimmed.starts_with("- [") {
        return None;
    }

    let after_dash = &trimmed[2..];
    if after_dash.len() < 4 {
        return None;
    }

    let done_char = after_dash.chars().nth(1)?;
    let done = done_char == 'x' || done_char == 'X';

    let after_bracket = after_dash.find("] ")?;
    let rest = &after_dash[after_bracket + 2..];

    if !rest.starts_with("**") {
        return None;
    }
    let bold_end = rest[2..].find("**")?;
    let bold_content = &rest[2..2 + bold_end];

    let colon_pos = bold_content.find(": ")?;
    let id = bold_content[..colon_pos].trim().to_string();
    let title = bold_content[colon_pos + 2..].trim().to_string();

    let after_bold = &rest[2 + bold_end + 2..];

    let risk = if let Some(start) = after_bold.find("`risk:") {
        let val_start = start + 6;
        let val_end = after_bold[val_start..].find('`').unwrap_or(0) + val_start;
        after_bold[val_start..val_end].to_string()
    } else {
        "low".to_string()
    };

    let depends = if let Some(start) = after_bold.find("`depends:[") {
        let val_start = start + 10;
        let val_end = after_bold[val_start..].find(']').unwrap_or(0) + val_start;
        let inner = &after_bold[val_start..val_end];
        if inner.trim().is_empty() {
            Vec::new()
        } else {
            inner.split(',').map(|s| s.trim().to_string()).collect()
        }
    } else {
        Vec::new()
    };

    Some(NativeRoadmapSlice {
        id,
        title,
        risk,
        depends,
        done,
        demo: String::new(),
    })
}

fn parse_boundary_map_internal(content: &str) -> Vec<NativeBoundaryMapEntry> {
    let bm_section = match extract_section_internal(content, "Boundary Map", 2) {
        Some(s) => s,
        None => return Vec::new(),
    };

    let h3_sections = extract_all_sections_internal(&bm_section, 3);
    let mut entries = Vec::new();

    for (heading, section_content) in h3_sections {
        let arrow_pos = heading.find('\u{2192}')
            .or_else(|| heading.find("->"));

        if let Some(pos) = arrow_pos {
            let arrow_len = if heading[pos..].starts_with('\u{2192}') {
                '\u{2192}'.len_utf8()
            } else {
                2
            };
            let from_slice = heading[..pos].trim().split_whitespace().next().unwrap_or("").to_string();
            let to_slice = heading[pos + arrow_len..].trim().split_whitespace().next().unwrap_or("").to_string();

            let mut produces = String::new();
            let mut consumes = String::new();

            if let Some(prod_idx) = section_content.find("Produces:") {
                let after_prod = &section_content[prod_idx + 9..];
                let end = after_prod.find("Consumes").unwrap_or(after_prod.len());
                produces = after_prod[..end].trim().to_string();
            }

            for line in section_content.lines() {
                let trimmed = line.trim();
                if trimmed.starts_with("Consumes") && trimmed.contains(':') {
                    let after_colon = trimmed[trimmed.find(':').unwrap() + 1..].trim();
                    if !after_colon.is_empty() {
                        consumes = after_colon.to_string();
                    }
                }
            }
            if consumes.is_empty() {
                if let Some(cons_idx) = section_content.find("Consumes") {
                    let colon_idx = section_content[cons_idx..].find(':');
                    if let Some(ci) = colon_idx {
                        let after = &section_content[cons_idx + ci + 1..];
                        consumes = after.trim().to_string();
                    }
                }
            }

            entries.push(NativeBoundaryMapEntry {
                from_slice,
                to_slice,
                produces,
                consumes,
            });
        }
    }

    entries
}

// ─── N-API Exports ──────────────────────────────────────────────────────────

/// Parse YAML-like frontmatter from markdown content.
///
/// Returns `{ metadata: string, body: string }` where metadata is a JSON string
/// of the parsed frontmatter key-value pairs.
#[napi(js_name = "parseFrontmatter")]
pub fn parse_frontmatter(content: String) -> FrontmatterResult {
    let (fm_lines, body) = split_frontmatter_internal(&content);
    let metadata = match fm_lines {
        Some(lines) => {
            let map = parse_frontmatter_map_internal(&lines);
            fm_to_json(&map)
        }
        None => "{}".to_string(),
    };

    FrontmatterResult {
        metadata,
        body: body.to_string(),
    }
}

/// Extract a section from markdown content by heading name and level.
///
/// Returns `{ content: string, found: boolean }`.
#[napi(js_name = "extractSection")]
pub fn extract_section(content: String, heading: String, level: Option<u32>) -> SectionResult {
    let level = level.unwrap_or(2);
    match extract_section_internal(&content, &heading, level) {
        Some(s) => SectionResult {
            content: s,
            found: true,
        },
        None => SectionResult {
            content: String::new(),
            found: false,
        },
    }
}

/// Extract all sections at a given heading level.
///
/// Returns a JSON string mapping heading names to their content.
#[napi(js_name = "extractAllSections")]
pub fn extract_all_sections(content: String, level: Option<u32>) -> String {
    let level = level.unwrap_or(2);
    let sections = extract_all_sections_internal(&content, level);
    sections_to_json(&sections)
}

/// Batch-parse all `.md` files in a `.gsd/` directory tree.
///
/// Reads all markdown files under the given directory, parses frontmatter
/// and extracts all level-2 sections for each file. Returns all results
/// in a single call, avoiding repeated JS<->native boundary crossings.
#[napi(js_name = "batchParseGsdFiles")]
pub fn batch_parse_gsd_files(directory: String) -> Result<BatchParseResult> {
    let dir_path = Path::new(&directory);
    if !dir_path.exists() {
        return Ok(BatchParseResult {
            files: Vec::new(),
            count: 0,
        });
    }

    // Collect all .md file paths
    let md_files = collect_md_files(dir_path, dir_path)?;

    // Read all files
    let mut file_contents: Vec<(String, String)> = Vec::with_capacity(md_files.len());
    for path in &md_files {
        let full_path = dir_path.join(path);
        match std::fs::read_to_string(&full_path) {
            Ok(content) => file_contents.push((path.clone(), content)),
            Err(_) => continue,
        }
    }

    // Parse all files — string parsing in Rust is already much faster than JS regex
    let mut parsed_files = Vec::with_capacity(file_contents.len());
    for (path, content) in &file_contents {
        let (fm_lines, body) = split_frontmatter_internal(content);
        let metadata = match fm_lines {
            Some(lines) => {
                let map = parse_frontmatter_map_internal(&lines);
                fm_to_json(&map)
            }
            None => "{}".to_string(),
        };

        let sections = extract_all_sections_internal(body, 2);
        let sections_json = sections_to_json(&sections);

        parsed_files.push(ParsedGsdFile {
            path: path.clone(),
            metadata,
            body: body.to_string(),
            sections: sections_json,
        });
    }

    let count = parsed_files.len() as u32;
    Ok(BatchParseResult {
        files: parsed_files,
        count,
    })
}

/// Recursively collect all .md files under a directory.
fn collect_md_files(base: &Path, dir: &Path) -> Result<Vec<String>> {
    let mut files = Vec::new();

    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) => {
            return Err(napi::Error::from_reason(format!(
                "Failed to read directory {}: {}",
                dir.display(),
                e
            )));
        }
    };

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };

        if file_type.is_dir() {
            let sub_files = collect_md_files(base, &path)?;
            files.extend(sub_files);
        } else if file_type.is_file() {
            if let Some(ext) = path.extension() {
                if ext == "md" {
                    if let Ok(relative) = path.strip_prefix(base) {
                        files.push(relative.to_string_lossy().to_string());
                    }
                }
            }
        }
    }

    Ok(files)
}

/// Parse a roadmap file's content into structured data.
///
/// Returns a `NativeRoadmap` with title, vision, success criteria, slices, and boundary map.
#[napi(js_name = "parseRoadmapFile")]
pub fn parse_roadmap_file(content: String) -> NativeRoadmap {
    parse_roadmap_internal(&content)
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_split_frontmatter() {
        let content = "---\nid: S01\ntitle: Test\n---\n\n# Body here";
        let (fm, body) = split_frontmatter_internal(content);
        assert!(fm.is_some());
        let lines = fm.unwrap();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], "id: S01");
        assert_eq!(lines[1], "title: Test");
        assert_eq!(body, "# Body here");
    }

    #[test]
    fn test_split_frontmatter_none() {
        let content = "# No frontmatter\nJust body.";
        let (fm, body) = split_frontmatter_internal(content);
        assert!(fm.is_none());
        assert_eq!(body, content);
    }

    #[test]
    fn test_parse_frontmatter_scalars() {
        let lines = vec!["id: S01", "title: My Title", "status: active"];
        let map = parse_frontmatter_map_internal(&lines);
        assert_eq!(map.len(), 3);
        match &map[0].1 {
            FmValue::Scalar(s) => assert_eq!(s, "S01"),
            _ => panic!("expected scalar"),
        }
    }

    #[test]
    fn test_parse_frontmatter_array() {
        let lines = vec!["provides:", "  - api", "  - types"];
        let map = parse_frontmatter_map_internal(&lines);
        assert_eq!(map.len(), 1);
        match &map[0].1 {
            FmValue::Array(items) => {
                assert_eq!(items.len(), 2);
            }
            _ => panic!("expected array"),
        }
    }

    #[test]
    fn test_parse_frontmatter_inline_array() {
        let lines = vec!["tags: [a, b, c]"];
        let map = parse_frontmatter_map_internal(&lines);
        assert_eq!(map.len(), 1);
        match &map[0].1 {
            FmValue::Array(items) => assert_eq!(items.len(), 3),
            _ => panic!("expected array"),
        }
    }

    #[test]
    fn test_parse_frontmatter_nested_objects() {
        let lines = vec![
            "requires:",
            "  - slice: S00",
            "    provides: core-api",
            "  - slice: S01",
            "    provides: types",
        ];
        let map = parse_frontmatter_map_internal(&lines);
        assert_eq!(map.len(), 1);
        match &map[0].1 {
            FmValue::Array(items) => {
                assert_eq!(items.len(), 2);
                match &items[0] {
                    FmArrayItem::Obj(pairs) => {
                        assert_eq!(pairs[0], ("slice".to_string(), "S00".to_string()));
                        assert_eq!(pairs[1], ("provides".to_string(), "core-api".to_string()));
                    }
                    _ => panic!("expected obj"),
                }
            }
            _ => panic!("expected array"),
        }
    }

    #[test]
    fn test_extract_section() {
        let body = "## First\nContent one.\n\n## Second\nContent two.\n\n## Third\nContent three.";
        let result = extract_section_internal(body, "Second", 2);
        assert_eq!(result.unwrap(), "Content two.");
    }

    #[test]
    fn test_extract_section_not_found() {
        let body = "## First\nContent one.";
        let result = extract_section_internal(body, "Missing", 2);
        assert!(result.is_none());
    }

    #[test]
    fn test_extract_section_last() {
        let body = "## First\nContent one.\n\n## Last\nFinal content.";
        let result = extract_section_internal(body, "Last", 2);
        assert_eq!(result.unwrap(), "Final content.");
    }

    #[test]
    fn test_extract_all_sections() {
        let body = "## A\nContent A\n\n## B\nContent B";
        let sections = extract_all_sections_internal(body, 2);
        assert_eq!(sections.len(), 2);
        assert_eq!(sections[0].0, "A");
        assert_eq!(sections[0].1, "Content A");
        assert_eq!(sections[1].0, "B");
        assert_eq!(sections[1].1, "Content B");
    }

    #[test]
    fn test_parse_bullets() {
        let text = "- Item one\n- Item two\n* Item three\n\n# Heading";
        let bullets = parse_bullets(text);
        assert_eq!(bullets, vec!["Item one", "Item two", "Item three"]);
    }

    #[test]
    fn test_extract_bold_field() {
        let text = "Some text\n**Vision:** Build something great\n**Goal:** Ship it";
        assert_eq!(
            extract_bold_field(text, "Vision"),
            Some("Build something great")
        );
        assert_eq!(extract_bold_field(text, "Goal"), Some("Ship it"));
        assert_eq!(extract_bold_field(text, "Missing"), None);
    }

    #[test]
    fn test_parse_slice_checkbox_line() {
        let line = "- [x] **S01: Core Types** `risk:low` `depends:[]`";
        let slice = parse_slice_checkbox_line(line).unwrap();
        assert_eq!(slice.id, "S01");
        assert_eq!(slice.title, "Core Types");
        assert_eq!(slice.risk, "low");
        assert!(slice.done);
        assert!(slice.depends.is_empty());
    }

    #[test]
    fn test_parse_slice_checkbox_with_depends() {
        let line = "- [ ] **S02: API Layer** `risk:medium` `depends:[S01,S00]`";
        let slice = parse_slice_checkbox_line(line).unwrap();
        assert_eq!(slice.id, "S02");
        assert_eq!(slice.title, "API Layer");
        assert_eq!(slice.risk, "medium");
        assert!(!slice.done);
        assert_eq!(slice.depends, vec!["S01", "S00"]);
    }

    #[test]
    fn test_fm_to_json() {
        let map = vec![
            ("id".to_string(), FmValue::Scalar("S01".to_string())),
            (
                "tags".to_string(),
                FmValue::Array(vec![
                    FmArrayItem::Str("a".to_string()),
                    FmArrayItem::Str("b".to_string()),
                ]),
            ),
        ];
        let json = fm_to_json(&map);
        assert_eq!(json, r#"{"id":"S01","tags":["a","b"]}"#);
    }

    #[test]
    fn test_fm_to_json_with_objects() {
        let map = vec![(
            "requires".to_string(),
            FmValue::Array(vec![FmArrayItem::Obj(vec![
                ("slice".to_string(), "S00".to_string()),
                ("provides".to_string(), "api".to_string()),
            ])]),
        )];
        let json = fm_to_json(&map);
        assert_eq!(json, r#"{"requires":[{"slice":"S00","provides":"api"}]}"#);
    }

    #[test]
    fn test_json_escape() {
        let mut out = String::new();
        json_escape_into(&mut out, "hello \"world\"\nnewline");
        assert_eq!(out, "hello \\\"world\\\"\\nnewline");
    }

    #[test]
    fn test_parse_roadmap_slices() {
        let content = r#"# M001: Test Milestone

**Vision:** Build something

## Slices

- [x] **S01: Core Types** `risk:low` `depends:[]`
  > After this: types are defined
- [ ] **S02: API Layer** `risk:medium` `depends:[S01]`
  > After this: API is working

## Boundary Map
"#;
        let slices = parse_roadmap_slices_internal(content);
        assert_eq!(slices.len(), 2);
        assert_eq!(slices[0].id, "S01");
        assert!(slices[0].done);
        assert_eq!(slices[0].demo, "types are defined");
        assert_eq!(slices[1].id, "S02");
        assert!(!slices[1].done);
        assert_eq!(slices[1].depends, vec!["S01"]);
    }
}
