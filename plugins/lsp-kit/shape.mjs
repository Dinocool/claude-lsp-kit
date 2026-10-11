// Shapes server->client responses before Claude Code renders them, cutting
// what the rendering spends tokens on without losing anything a ranged Read
// can't recover once the outline gives the lines. The proxy applies this
// (proxy.mjs), not the manager: the switch is per session, and the shared
// manager's protocol digest is untouched, so an updated session shapes its
// answers at once beside sessions still on the old proxy. LSPKIT_RAW=1 passes
// every response through unchanged (debugging).
//
// textDocument/documentSymbol: the outline keeps what navigation needs. A
// symbol stays when any of these holds: it is at file level; its kind is
// navigational (Namespace, Package, Module, Class, Method, Constructor, Enum,
// Interface, Function, Struct); its parent declares a type (Class, Enum,
// Interface, Struct), whose members are its API whatever their kind; or it
// still has kept children — a node is dropped once its children are all
// dropped, so a table that holds functions stays with them. Everything else
// below file level under a non-type parent (table fields, object-literal
// properties, local variables) goes, recoverable by a ranged Read. Name,
// kind, ranges and detail are passed through untouched. A flat
// SymbolInformation[] answer (no `children`) is left alone: it has no tree to
// prune.
//
// references/definition/implementation/declaration/typeDefinition: identical
// uri+range entries are deduped and the server's order kept (its primary
// result first for definitions). Never capped: the client prints its own
// count header ("Found N references"), and a shorter list would falsify it.
//
// hover is passed through: measured small, and trimming its markdown would be
// guesswork.

// LSP 3.17 SymbolKind numbers: Module, Namespace, Package, Class, Method,
// Constructor, Enum, Interface, Function, Struct.
export const NAVIGATIONAL = new Set([2, 3, 4, 5, 6, 9, 10, 11, 12, 23]);
// Kinds that declare a type, whose members are its API: Class, Enum,
// Interface, Struct.
const TYPES = new Set([5, 10, 11, 23]);
// The outline's keep rule for one symbol, its kept children apart: file
// level, a navigational kind, or a type-declaring parent. Exported so the
// tests check this rule, not a copy of it.
export const stays = (kind, depth, parent) => depth === 1 || NAVIGATIONAL.has(kind) || TYPES.has(parent);
const OUTLINE = 'textDocument/documentSymbol';
const LOCATIONS = new Set(['textDocument/references', 'textDocument/definition', 'textDocument/implementation', 'textDocument/declaration', 'textDocument/typeDefinition']);

export function shape(method, result) {
	if (process.env.LSPKIT_RAW === '1') return result;
	if (method === OUTLINE) return outline(result);
	return LOCATIONS.has(method) ? locations(result) : result;
}

// DocumentSymbol[]: the children tree pruned per the rule above. Arrays that
// end up unchanged keep their identity, so untouched nodes are never copied.
function outline(symbols) {
	if (!Array.isArray(symbols) || symbols.some((s) => !s?.range)) return symbols;
	const walk = (list, depth, parent) => {
		let changed = false;
		const kept = [];
		for (const s of list) {
			const children = s.children ? walk(s.children, depth + 1, s.kind) : s.children;
			if (stays(s.kind, depth, parent) || children?.length) {
				if (children === s.children) kept.push(s);
				else {
					changed = true;
					const copy = { ...s };
					if (children?.length) copy.children = children;
					else delete copy.children;
					kept.push(copy);
				}
			} else changed = true;
		}
		return changed ? kept : list;
	};
	return walk(symbols, 1, 0);
}

// Location[] or LocationLink[] (the uri and range of either shape; LSP 3.17
// LocationLink targets). Deduped by the whole uri+range — a LocationLink's
// originSelectionRange included, so two links to one target from different
// origins both stay — in the server's order; an entry without a uri and a
// start is a shape this doesn't know, and the whole list passes through
// rather than half-shaped.
function locations(list) {
	if (!Array.isArray(list)) return list;
	const uriOf = (l) => l.targetUri ?? l.uri;
	const startOf = (l) => (l.targetRange ?? l.range)?.start;
	if (list.some((l) => !uriOf(l) || !startOf(l))) return list;
	const seen = new Set();
	return list.filter((l) => {
		const key = JSON.stringify([uriOf(l), l.targetRange ?? l.range, l.originSelectionRange]);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
