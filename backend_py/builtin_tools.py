import ast
import datetime
import operator
import re

TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "get_current_time",
            "description": "Get the current date and time of the server, including timezone.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "calculate",
            "description": "Evaluate a basic arithmetic expression. Supports + - * / // % ** and parentheses.",
            "parameters": {
                "type": "object",
                "properties": {
                    "expression": {
                        "type": "string",
                        "description": "Arithmetic expression, e.g. (2 + 3) * 4",
                    }
                },
                "required": ["expression"],
            },
        },
    },
]

_OPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
    ast.USub: operator.neg,
    ast.UAdd: operator.pos,
}

# Only digits, whitespace, and the supported operators/parentheses may appear in
# the raw input. This rejects names, calls, attribute access, strings, etc. before
# they ever reach the parser.
_ALLOWED_CHARS = re.compile(r"^[\d\s.+\-*/%()]+$")
_MAX_EXPR_LEN = 200
# Cap exponentiation: even pure-arithmetic input like 9**9**9 can exhaust CPU/memory.
_MAX_POW_BASE = 1_000_000
_MAX_POW_EXP = 100


def _eval_node(node: ast.expr):
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
        return node.value
    if isinstance(node, ast.BinOp) and type(node.op) in _OPS:
        left = _eval_node(node.left)
        right = _eval_node(node.right)
        if isinstance(node.op, ast.Pow) and (abs(right) > _MAX_POW_EXP or abs(left) > _MAX_POW_BASE):
            raise ValueError("Exponent or base too large")
        return _OPS[type(node.op)](left, right)
    if isinstance(node, ast.UnaryOp) and type(node.op) in _OPS:
        return _OPS[type(node.op)](_eval_node(node.operand))
    raise ValueError("Only numbers and arithmetic operators are supported")


def calculate(expression: str):
    expression = expression.strip()
    if not expression:
        raise ValueError("Empty expression")
    if len(expression) > _MAX_EXPR_LEN:
        raise ValueError("Expression too long")
    if not _ALLOWED_CHARS.match(expression):
        raise ValueError("Only numbers and the operators + - * / // % ** ( ) are allowed")
    tree = ast.parse(expression, mode="eval")
    return _eval_node(tree.body)


def get_current_time() -> str:
    return datetime.datetime.now().astimezone().isoformat()


async def call_builtin(name: str, arguments: dict) -> str:
    if name == "get_current_time":
        return get_current_time()
    if name == "calculate":
        return str(calculate(str(arguments.get("expression", ""))))
    raise ValueError(f"Unknown builtin tool: {name}")
