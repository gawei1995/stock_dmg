(function installCockpitMarkdown(root) {
  const MAX_EXTERNAL_URL_LENGTH = 4_096;
  const GOOGLE_REDIRECT_HOSTS = new Set([
    "google.com",
    "www.google.com",
    "google.com.hk",
    "www.google.com.hk",
    "google.cn",
    "www.google.cn",
  ]);

  function tokenizeMarkdown(value) {
    const lines = String(value ?? "").replace(/\r\n?/g, "\n").split("\n");
    const tokens = [];
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) {
        index += 1;
        continue;
      }
      const fence = line.match(/^\s*```([^`]*)$/);
      if (fence) {
        const body = [];
        index += 1;
        while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
          body.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) index += 1;
        tokens.push({ type: "code", language: fence[1].trim(), text: body.join("\n") });
        continue;
      }
      const heading = line.match(/^\s*(#{1,4})\s+(.+)$/);
      if (heading) {
        tokens.push({ type: "heading", level: heading[1].length, text: heading[2].trim() });
        index += 1;
        continue;
      }
      if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
        tokens.push({ type: "rule" });
        index += 1;
        continue;
      }
      if (looksLikeTableRow(line) && index + 1 < lines.length && looksLikeTableDivider(lines[index + 1])) {
        const rows = [splitTableRow(line)];
        index += 2;
        while (index < lines.length && looksLikeTableRow(lines[index]) && lines[index].trim()) {
          rows.push(splitTableRow(lines[index]));
          index += 1;
        }
        tokens.push({ type: "table", header: rows[0], rows: rows.slice(1) });
        continue;
      }
      if (/^\s*>\s?/.test(line)) {
        const body = [];
        while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
          body.push(lines[index].replace(/^\s*>\s?/, ""));
          index += 1;
        }
        tokens.push({ type: "quote", text: body.join("\n") });
        continue;
      }
      const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (unordered || ordered) {
        const orderedList = Boolean(ordered);
        const items = [];
        const pattern = orderedList ? /^\s*\d+[.)]\s+(.+)$/ : /^\s*[-*+]\s+(.+)$/;
        while (index < lines.length) {
          const match = lines[index].match(pattern);
          if (!match) break;
          items.push(match[1].trim());
          index += 1;
        }
        tokens.push({ type: "list", ordered: orderedList, items });
        continue;
      }
      const paragraph = [line.trim()];
      index += 1;
      while (index < lines.length && lines[index].trim() && !isBlockStart(lines, index)) {
        paragraph.push(lines[index].trim());
        index += 1;
      }
      tokens.push({ type: "paragraph", text: paragraph.join("\n") });
    }
    return tokens;
  }

  function renderMarkdown(container, value) {
    if (!container) return;
    container.replaceChildren();
    for (const token of tokenizeMarkdown(value)) {
      if (token.type === "heading") {
        const heading = document.createElement(token.level <= 2 ? "h3" : "h4");
        appendInline(heading, token.text);
        container.append(heading);
      } else if (token.type === "paragraph") {
        const paragraph = document.createElement("p");
        token.text.split("\n").forEach((line, index) => {
          if (index) paragraph.append(document.createElement("br"));
          appendInline(paragraph, line);
        });
        container.append(paragraph);
      } else if (token.type === "list") {
        const list = document.createElement(token.ordered ? "ol" : "ul");
        for (const item of token.items) {
          const entry = document.createElement("li");
          appendInline(entry, item);
          list.append(entry);
        }
        container.append(list);
      } else if (token.type === "quote") {
        const quote = document.createElement("blockquote");
        appendInline(quote, token.text);
        container.append(quote);
      } else if (token.type === "code") {
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        if (token.language) code.dataset.language = token.language.slice(0, 30);
        code.textContent = token.text;
        pre.append(code);
        container.append(pre);
      } else if (token.type === "table") {
        const wrapper = document.createElement("div");
        wrapper.className = "markdown-table-wrap";
        const table = document.createElement("table");
        const head = document.createElement("thead");
        const headRow = document.createElement("tr");
        for (const cell of token.header) {
          const node = document.createElement("th");
          appendInline(node, cell);
          headRow.append(node);
        }
        head.append(headRow);
        table.append(head);
        const body = document.createElement("tbody");
        for (const row of token.rows) {
          const rowNode = document.createElement("tr");
          for (const cell of row) {
            const node = document.createElement("td");
            appendInline(node, cell);
            rowNode.append(node);
          }
          body.append(rowNode);
        }
        table.append(body);
        wrapper.append(table);
        container.append(wrapper);
      } else if (token.type === "rule") {
        container.append(document.createElement("hr"));
      }
    }
  }

  function appendInline(parent, value) {
    const source = String(value ?? "");
    let cursor = 0;
    while (cursor < source.length) {
      const link = findNextExternalLink(source, cursor);
      if (!link) {
        appendFormattedInline(parent, source.slice(cursor));
        return;
      }
      if (link.start > cursor) appendFormattedInline(parent, source.slice(cursor, link.start));
      if (link.url) {
        parent.append(createExternalLink(link.url, link.label, link.title));
      } else {
        appendFormattedInline(parent, link.label || source.slice(link.start, link.end));
      }
      cursor = link.end;
    }
  }

  function appendFormattedInline(parent, source) {
    const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*)/g;
    let cursor = 0;
    for (const match of source.matchAll(pattern)) {
      if (match.index > cursor) parent.append(document.createTextNode(source.slice(cursor, match.index)));
      const raw = match[0];
      let node;
      if (raw.startsWith("`")) node = document.createElement("code");
      else if (raw.startsWith("**") || raw.startsWith("__")) node = document.createElement("strong");
      else node = document.createElement("em");
      const trim = raw.startsWith("**") || raw.startsWith("__") ? 2 : 1;
      node.textContent = raw.slice(trim, -trim);
      parent.append(node);
      cursor = match.index + raw.length;
    }
    if (cursor < source.length) parent.append(document.createTextNode(source.slice(cursor)));
  }

  function findNextExternalLink(source, fromIndex) {
    for (let index = fromIndex; index < source.length; index += 1) {
      if (source[index] === "`") {
        const codeEnd = source.indexOf("`", index + 1);
        if (codeEnd >= 0) {
          index = codeEnd;
          continue;
        }
      }
      if (source[index] === "[") {
        const markdownLink = parseMarkdownLink(source, index);
        if (markdownLink) return markdownLink;
      }
      if (source[index] === "<") {
        const autolink = parseAngleAutolink(source, index);
        if (autolink) return autolink;
      }
      if (source.slice(index, index + 8).toLowerCase() === "https://"
        && isBareUrlBoundary(source, index)) {
        const bareLink = parseBareUrl(source, index);
        if (bareLink) return bareLink;
      }
    }
    return null;
  }

  function parseMarkdownLink(source, start) {
    const labelEnd = findClosingLabel(source, start + 1);
    if (labelEnd < 0 || source[labelEnd + 1] !== "(") return null;
    const destination = parseLinkDestination(source, labelEnd + 1);
    if (!destination) return null;
    const label = unescapeMarkdown(source.slice(start + 1, labelEnd)).trim();
    const url = normalizeExternalUrl(destination.url);
    return {
      start,
      end: destination.end,
      label: label || compactExternalLabel(url),
      title: destination.title,
      url,
    };
  }

  function findClosingLabel(source, fromIndex) {
    let nested = 0;
    for (let index = fromIndex; index < source.length; index += 1) {
      if (source[index] === "\\") {
        index += 1;
        continue;
      }
      if (source[index] === "[") nested += 1;
      if (source[index] === "]") {
        if (nested === 0) return index;
        nested -= 1;
      }
    }
    return -1;
  }

  function parseLinkDestination(source, openIndex) {
    let cursor = openIndex + 1;
    while (/[ \t]/.test(source[cursor] ?? "")) cursor += 1;
    let destination = "";
    if (source[cursor] === "<") {
      const end = findUnescaped(source, ">", cursor + 1);
      if (end < 0 || /[\n<>]/.test(source.slice(cursor + 1, end))) return null;
      destination = source.slice(cursor + 1, end);
      cursor = end + 1;
    } else {
      const destinationStart = cursor;
      let nested = 0;
      for (; cursor < source.length; cursor += 1) {
        const character = source[cursor];
        if (character === "\\") {
          cursor += 1;
          continue;
        }
        if (character === "(") {
          nested += 1;
          continue;
        }
        if (character === ")") {
          if (nested === 0) {
            destination = source.slice(destinationStart, cursor);
            return {
              url: decodeMarkdownDestination(destination),
              title: "",
              end: cursor + 1,
            };
          }
          nested -= 1;
          continue;
        }
        if (/[ \t]/.test(character) && nested === 0) {
          destination = source.slice(destinationStart, cursor);
          break;
        }
        if (character === "\n") return null;
      }
      if (!destination) return null;
    }

    const spacingStart = cursor;
    while (/[ \t]/.test(source[cursor] ?? "")) cursor += 1;
    if (source[cursor] === ")") {
      return {
        url: decodeMarkdownDestination(destination),
        title: "",
        end: cursor + 1,
      };
    }
    if (cursor === spacingStart) return null;
    const delimiter = source[cursor];
    const closing = delimiter === "(" ? ")" : delimiter;
    if (!["\"", "'", "("].includes(delimiter)) return null;
    const titleStart = cursor + 1;
    const titleEnd = findUnescaped(source, closing, titleStart);
    if (titleEnd < 0 || source.slice(titleStart, titleEnd).includes("\n")) return null;
    cursor = titleEnd + 1;
    while (/[ \t]/.test(source[cursor] ?? "")) cursor += 1;
    if (source[cursor] !== ")") return null;
    return {
      url: decodeMarkdownDestination(destination),
      title: unescapeMarkdown(source.slice(titleStart, titleEnd)).trim(),
      end: cursor + 1,
    };
  }

  function parseAngleAutolink(source, start) {
    if (source.slice(start + 1, start + 9).toLowerCase() !== "https://") return null;
    const end = source.indexOf(">", start + 9);
    if (end < 0 || /[\s<>]/.test(source.slice(start + 1, end))) return null;
    const url = normalizeExternalUrl(source.slice(start + 1, end));
    if (!url) return null;
    return {
      start,
      end: end + 1,
      label: compactExternalLabel(url),
      title: "",
      url,
    };
  }

  function parseBareUrl(source, start) {
    let end = start;
    while (end < source.length && !/[\s<>"'`*，。；：！？、》】]/.test(source[end])) end += 1;
    const raw = trimBareUrlPunctuation(source.slice(start, end));
    if (!raw) return null;
    const url = normalizeExternalUrl(raw);
    if (!url) return null;
    return {
      start,
      end: start + raw.length,
      label: compactExternalLabel(url),
      title: "",
      url,
    };
  }

  function trimBareUrlPunctuation(value) {
    let result = value;
    while (/[.,;:!?，。；：！？、》】\]}]$/.test(result)) result = result.slice(0, -1);
    while (result.endsWith(")") && countCharacter(result, ")") > countCharacter(result, "(")) {
      result = result.slice(0, -1);
    }
    while (result.endsWith("）") && countCharacter(result, "）") > countCharacter(result, "（")) {
      result = result.slice(0, -1);
    }
    return result;
  }

  function countCharacter(value, character) {
    return [...value].filter((item) => item === character).length;
  }

  function isBareUrlBoundary(source, index) {
    if (index === 0) return true;
    if (source.slice(Math.max(0, index - 2), index) === "](") return false;
    return /[\s([<{"'（【《，。；：！？、]/.test(source[index - 1]);
  }

  function normalizeExternalUrl(value) {
    return normalizeExternalUrlAtDepth(value, 0);
  }

  function normalizeExternalUrlAtDepth(value, depth) {
    const source = decodeMarkdownDestination(value).trim();
    if (!source || source.length > MAX_EXTERNAL_URL_LENGTH || /[\u0000-\u001f\u007f]/.test(source)) {
      return null;
    }
    try {
      const url = new URL(source);
      if (url.protocol !== "https:" || url.username || url.password || !url.hostname) return null;
      if (GOOGLE_REDIRECT_HOSTS.has(url.hostname)
        && /^\/url\/?$/.test(url.pathname)
        && depth < 2) {
        const destination = url.searchParams.get("url") ?? url.searchParams.get("q");
        if (destination) return normalizeExternalUrlAtDepth(destination, depth + 1);
      }
      const normalized = url.toString();
      return normalized.length <= MAX_EXTERNAL_URL_LENGTH ? normalized : null;
    } catch {
      return null;
    }
  }

  function decodeMarkdownDestination(value) {
    return unescapeMarkdown(String(value ?? ""))
      .replace(/&amp;|&#0*38;|&#x0*26;/gi, "&");
  }

  function unescapeMarkdown(value) {
    return String(value ?? "").replace(/\\([\\`*_[\]{}()#+.!<>-])/g, "$1");
  }

  function findUnescaped(source, character, fromIndex) {
    for (let index = fromIndex; index < source.length; index += 1) {
      if (source[index] === "\\") {
        index += 1;
        continue;
      }
      if (source[index] === character) return index;
    }
    return -1;
  }

  function compactExternalLabel(value) {
    try {
      const url = new URL(value);
      if (GOOGLE_REDIRECT_HOSTS.has(url.hostname) && url.pathname === "/search") return "Google 搜索";
      const path = url.pathname === "/" ? "" : url.pathname;
      const label = `${url.hostname}${path}`;
      return label.length > 56 ? `${label.slice(0, 53)}…` : label;
    } catch {
      return "外部链接";
    }
  }

  function createExternalLink(url, label, title) {
    const anchor = document.createElement("a");
    anchor.className = "external-link";
    anchor.href = url;
    anchor.rel = "noopener noreferrer";
    anchor.dataset.externalUrl = url;
    anchor.textContent = label || compactExternalLabel(url);
    let hostname = "外部网站";
    try {
      hostname = new URL(url).hostname;
    } catch {
      // The URL was normalized immediately before this call.
    }
    anchor.title = String(title || `在浏览器中打开 ${hostname}`).slice(0, 200);
    anchor.setAttribute("aria-label", `${anchor.textContent}（在外部浏览器中打开）`);
    anchor.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation?.();
      const openExternal = root.cockpit?.openExternal;
      if (typeof openExternal !== "function") return;
      Promise.resolve(openExternal(url)).catch(() => {});
    });
    return anchor;
  }

  function isBlockStart(lines, index) {
    const line = lines[index];
    return /^\s*(?:```|#{1,4}\s|>|[-*+]\s+|\d+[.)]\s+)/.test(line)
      || /^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)
      || (looksLikeTableRow(line) && index + 1 < lines.length && looksLikeTableDivider(lines[index + 1]));
  }

  function looksLikeTableRow(line) {
    return String(line).includes("|") && splitTableRow(line).length >= 2;
  }

  function looksLikeTableDivider(line) {
    const cells = splitTableRow(line);
    return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
  }

  function splitTableRow(line) {
    const value = String(line).trim().replace(/^\|/, "").replace(/\|$/, "");
    return value.split("|").map((cell) => cell.trim());
  }

  root.CockpitMarkdown = Object.freeze({
    normalizeExternalUrl,
    renderMarkdown,
    tokenizeMarkdown,
  });
})(globalThis);
