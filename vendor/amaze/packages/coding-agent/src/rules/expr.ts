export interface ExprContext {
	$: unknown;
	count?: number;
	windowSize?: number;
	now?: number;
	thresholds?: Record<string, unknown>;
}

export interface CompiledExpr {
	readonly source: string;
	readonly ast: ExprNode;
}

type ExprNode =
	| { type: "literal"; value: string | number | boolean | null }
	| { type: "path"; base: "$" | "thresholds"; segments: Array<string | number> }
	| { type: "variable"; name: "$count" | "$windowSize" | "$now" }
	| { type: "unary"; operator: "!" | "-"; argument: ExprNode }
	| { type: "binary"; operator: BinaryOperator; left: ExprNode; right: ExprNode };

type BinaryOperator = "||" | "&&" | "==" | "!=" | "<" | ">" | "<=" | ">=" | "+" | "-" | "*" | "/" | "%";

type Token =
	| { type: "literal"; value: string | number | boolean | null }
	| { type: "identifier"; value: string }
	| { type: "number"; value: number }
	| { type: "string"; value: string }
	| { type: "operator"; value: string }
	| { type: "punct"; value: "(" | ")" | "." | "[" | "]" }
	| { type: "eof" };

const BINARY_PRECEDENCE: Record<BinaryOperator, number> = {
	"||": 1,
	"&&": 2,
	"==": 3,
	"!=": 3,
	"<": 4,
	">": 4,
	"<=": 4,
	">=": 4,
	"+": 5,
	"-": 5,
	"*": 6,
	"/": 6,
	"%": 6,
};

export function compileExpr(source: string): CompiledExpr {
	const parser = new ExprParser(tokenize(source), source);
	const ast = parser.parse();
	return { source, ast };
}

export function evaluate(expr: CompiledExpr, ctx: ExprContext): unknown {
	return evaluateNode(expr.ast, ctx);
}

function tokenize(source: string): Token[] {
	const tokens: Token[] = [];
	let index = 0;

	while (index < source.length) {
		const char = source[index];
		if (/\s/.test(char)) {
			index += 1;
			continue;
		}

		const two = source.slice(index, index + 2);
		if (["&&", "||", "==", "!=", "<=", ">="].includes(two)) {
			tokens.push({ type: "operator", value: two });
			index += 2;
			continue;
		}

		if (["<", ">", "+", "-", "*", "/", "%", "!"].includes(char)) {
			tokens.push({ type: "operator", value: char });
			index += 1;
			continue;
		}

		if (["(", ")", ".", "[", "]"].includes(char)) {
			tokens.push({ type: "punct", value: char as "(" | ")" | "." | "[" | "]" });
			index += 1;
			continue;
		}

		if (char === '"' || char === "'") {
			const parsed = readString(source, index);
			tokens.push({ type: "string", value: parsed.value });
			index = parsed.next;
			continue;
		}

		if (/\d/.test(char)) {
			const match = source.slice(index).match(/^\d+(?:\.\d+)?/);
			if (!match) throw new Error(`Invalid number at ${index}`);
			tokens.push({ type: "number", value: Number(match[0]) });
			index += match[0].length;
			continue;
		}

		if (/[A-Za-z_$]/.test(char)) {
			const match = source.slice(index).match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
			if (!match) throw new Error(`Invalid identifier at ${index}`);
			const value = match[0];
			if (value === "true") tokens.push({ type: "literal", value: true });
			else if (value === "false") tokens.push({ type: "literal", value: false });
			else if (value === "null") tokens.push({ type: "literal", value: null });
			else tokens.push({ type: "identifier", value });
			index += value.length;
			continue;
		}

		throw new Error(`Unexpected token at ${index}`);
	}

	tokens.push({ type: "eof" });
	return tokens;
}

function readString(source: string, start: number): { value: string; next: number } {
	const quote = source[start];
	let value = "";
	let index = start + 1;
	while (index < source.length) {
		const char = source[index];
		if (char === quote) return { value, next: index + 1 };
		if (char === "\\") {
			const escaped = source[index + 1];
			if (escaped === undefined) throw new Error("Unterminated string literal");
			const map: Record<string, string> = { n: "\n", r: "\r", t: "\t", "\\": "\\", '"': '"', "'": "'" };
			value += map[escaped] ?? escaped;
			index += 2;
			continue;
		}
		value += char;
		index += 1;
	}
	throw new Error("Unterminated string literal");
}

class ExprParser {
	#index = 0;

	constructor(
		private readonly tokens: Token[],
		private readonly source: string,
	) {}

	parse(): ExprNode {
		const expr = this.parseExpression(0);
		this.expect("eof");
		return expr;
	}

	private parseExpression(minPrecedence: number): ExprNode {
		let left = this.parsePrefix();
		while (true) {
			const token = this.peek();
			if (token.type !== "operator" || !isBinaryOperator(token.value)) break;
			const precedence = BINARY_PRECEDENCE[token.value];
			if (precedence < minPrecedence) break;
			this.advance();
			const right = this.parseExpression(precedence + 1);
			left = { type: "binary", operator: token.value, left, right };
		}
		return left;
	}

	private parsePrefix(): ExprNode {
		const token = this.advance();
		if (token.type === "literal" || token.type === "number" || token.type === "string") {
			return { type: "literal", value: token.value };
		}
		if (token.type === "operator" && (token.value === "!" || token.value === "-")) {
			return { type: "unary", operator: token.value, argument: this.parseExpression(7) };
		}
		if (token.type === "punct" && token.value === "(") {
			const expr = this.parseExpression(0);
			this.expectPunct(")");
			return expr;
		}
		if (token.type === "identifier") return this.parseIdentifier(token.value);
		throw new Error(`Invalid expression near ${this.source}`);
	}

	private parseIdentifier(value: string): ExprNode {
		if (value === "$count") return { type: "variable", name: "$count" };
		if (value === "$windowSize") return { type: "variable", name: "$windowSize" };
		if (value === "$now") return { type: "variable", name: "$now" };
		if (value === "$" || value === "thresholds") return this.parsePath(value);
		throw new Error(`Unsupported identifier: ${value}`);
	}

	private parsePath(base: "$" | "thresholds"): ExprNode {
		const segments: Array<string | number> = [];
		while (true) {
			const token = this.peek();
			if (token.type === "punct" && token.value === ".") {
				this.advance();
				const property = this.advance();
				if (property.type !== "identifier") throw new Error("Expected property name after .");
				segments.push(property.value);
				continue;
			}
			if (token.type === "punct" && token.value === "[") {
				this.advance();
				const index = this.advance();
				if (index.type !== "number" || !Number.isInteger(index.value)) throw new Error("Expected array index");
				this.expectPunct("]");
				segments.push(index.value);
				continue;
			}
			break;
		}
		return { type: "path", base, segments };
	}

	private expect(type: Token["type"]): Token {
		const token = this.advance();
		if (token.type !== type) throw new Error(`Expected ${type}`);
		return token;
	}

	private expectPunct(value: "(" | ")" | "." | "[" | "]"): void {
		const token = this.advance();
		if (token.type !== "punct" || token.value !== value) throw new Error(`Expected ${value}`);
	}

	private peek(): Token {
		return this.tokens[this.#index] ?? { type: "eof" };
	}

	private advance(): Token {
		const token = this.peek();
		this.#index += 1;
		return token;
	}
}

function isBinaryOperator(value: string): value is BinaryOperator {
	return Object.hasOwn(BINARY_PRECEDENCE, value);
}

function evaluateNode(node: ExprNode, ctx: ExprContext): unknown {
	switch (node.type) {
		case "literal":
			return node.value;
		case "variable":
			if (node.name === "$count") return ctx.count;
			if (node.name === "$windowSize") return ctx.windowSize;
			return ctx.now;
		case "path":
			return readPath(node.base === "$" ? ctx.$ : ctx.thresholds, node.segments);
		case "unary": {
			const value = evaluateNode(node.argument, ctx);
			return node.operator === "!" ? !value : -toNumber(value);
		}
		case "binary":
			return evaluateBinary(node.operator, node.left, node.right, ctx);
	}
}

function evaluateBinary(operator: BinaryOperator, leftNode: ExprNode, rightNode: ExprNode, ctx: ExprContext): unknown {
	if (operator === "&&") {
		const left = evaluateNode(leftNode, ctx);
		return left ? evaluateNode(rightNode, ctx) : left;
	}
	if (operator === "||") {
		const left = evaluateNode(leftNode, ctx);
		return left ? left : evaluateNode(rightNode, ctx);
	}

	const left = evaluateNode(leftNode, ctx);
	const right = evaluateNode(rightNode, ctx);
	switch (operator) {
		case "==":
			return left === right;
		case "!=":
			return left !== right;
		case "<":
			return toComparable(left) < toComparable(right);
		case ">":
			return toComparable(left) > toComparable(right);
		case "<=":
			return toComparable(left) <= toComparable(right);
		case ">=":
			return toComparable(left) >= toComparable(right);
		case "+":
			return typeof left === "string" || typeof right === "string"
				? `${left ?? ""}${right ?? ""}`
				: toNumber(left) + toNumber(right);
		case "-":
			return toNumber(left) - toNumber(right);
		case "*":
			return toNumber(left) * toNumber(right);
		case "/":
			return toNumber(left) / toNumber(right);
		case "%":
			return toNumber(left) % toNumber(right);
	}
}

function readPath(value: unknown, segments: Array<string | number>): unknown {
	let current = value;
	for (const segment of segments) {
		if (current === null || current === undefined) return undefined;
		if (typeof segment === "number") {
			if (!Array.isArray(current)) return undefined;
			current = current[segment];
			continue;
		}
		if (typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function toNumber(value: unknown): number {
	if (typeof value === "number") return value;
	if (typeof value === "boolean") return value ? 1 : 0;
	if (value === null) return 0;
	return Number(value);
}

function toComparable(value: unknown): number | string {
	return typeof value === "string" ? value : toNumber(value);
}
