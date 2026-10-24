let nextId = 1;
const todos = [];

export function createTodo(title, { tags = [] } = {}) {
  const todo = { id: nextId++, title, tags, done: false, createdAt: new Date().toISOString() };
  todos.push(todo);
  return todo;
}

export function listTodos({ includeDone = true } = {}) {
  return includeDone ? [...todos] : todos.filter((t) => !t.done);
}

export function completeTodo(id) {
  const todo = todos.find((t) => t.id === id);
  if (!todo) throw new Error(`No todo with id ${id}`);
  todo.done = true;
  return todo;
}

export function search(query) {
  return todos.filter((t) => t.title.includes(query));
}

export function reset() {
  todos.length = 0;
  nextId = 1;
}
