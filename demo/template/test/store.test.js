import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTodo, listTodos, completeTodo, search, reset } from "../src/store.js";

beforeEach(() => reset());

test("creates and lists todos", () => {
  createTodo("Write docs");
  assert.equal(listTodos().length, 1);
});

test("completes a todo", () => {
  const t = createTodo("Ship it");
  completeTodo(t.id);
  assert.equal(listTodos({ includeDone: false }).length, 0);
});

test("search finds by title", () => {
  createTodo("Fix login bug");
  assert.equal(search("login").length, 1);
});
