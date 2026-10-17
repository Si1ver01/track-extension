#!/usr/bin/env python3
"""Проверяем нативный диалог тестового Chrome через macOS Accessibility."""

import argparse
import ctypes
import json
import os
import sys


class AccessError(Exception):
    pass


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise AccessError(f"Некорректные аргументы: {message}.")


class Accessibility:
    UTF8 = 0x08000100

    def __init__(self):
        if sys.platform != "darwin":
            raise AccessError("Нужна macOS.")
        self.ax = ctypes.CDLL(
            "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices"
        )
        self.cf = ctypes.CDLL(
            "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"
        )
        pointer = ctypes.c_void_p
        self.bind(self.ax, "AXIsProcessTrusted", [], ctypes.c_bool)
        self.bind(self.ax, "AXIsProcessTrustedWithOptions", [pointer], ctypes.c_bool)
        self.bind(self.ax, "AXUIElementCreateApplication", [ctypes.c_int], pointer)
        self.bind(
            self.ax,
            "AXUIElementCopyAttributeValue",
            [pointer, pointer, ctypes.POINTER(pointer)],
            ctypes.c_int32,
        )
        self.bind(
            self.ax,
            "AXUIElementSetMessagingTimeout",
            [pointer, ctypes.c_float],
            ctypes.c_int32,
        )
        self.bind(
            self.ax,
            "AXUIElementPerformAction",
            [pointer, pointer],
            ctypes.c_int32,
        )
        self.bind(
            self.ax,
            "AXUIElementGetPid",
            [pointer, ctypes.POINTER(ctypes.c_int)],
            ctypes.c_int32,
        )
        self.bind(self.cf, "CFRelease", [pointer], None)
        self.bind(self.cf, "CFGetTypeID", [pointer], ctypes.c_ulong)
        self.bind(self.cf, "CFEqual", [pointer, pointer], ctypes.c_bool)
        for name in ("CFStringGetTypeID", "CFBooleanGetTypeID", "CFArrayGetTypeID"):
            self.bind(self.cf, name, [], ctypes.c_ulong)
        self.bind(
            self.cf,
            "CFStringCreateWithCString",
            [pointer, ctypes.c_char_p, ctypes.c_uint32],
            pointer,
        )
        self.bind(self.cf, "CFStringGetLength", [pointer], ctypes.c_long)
        self.bind(
            self.cf,
            "CFStringGetMaximumSizeForEncoding",
            [ctypes.c_long, ctypes.c_uint32],
            ctypes.c_long,
        )
        self.bind(
            self.cf,
            "CFStringGetCString",
            [pointer, pointer, ctypes.c_long, ctypes.c_uint32],
            ctypes.c_bool,
        )
        self.bind(self.cf, "CFBooleanGetValue", [pointer], ctypes.c_bool)
        self.bind(self.cf, "CFArrayGetCount", [pointer], ctypes.c_long)
        self.bind(
            self.cf,
            "CFArrayGetValueAtIndex",
            [pointer, ctypes.c_long],
            pointer,
        )
        self.bind(
            self.cf,
            "CFDictionaryCreate",
            [pointer, ctypes.POINTER(pointer), ctypes.POINTER(pointer), ctypes.c_long, pointer, pointer],
            pointer,
        )
        self.retained = []

    @staticmethod
    def bind(library, name, arguments, result):
        function = getattr(library, name)
        function.argtypes = arguments
        function.restype = result

    def string(self, value):
        result = self.cf.CFStringCreateWithCString(None, value.encode(), self.UTF8)
        if not result:
            raise AccessError("Не удалось создать строку CoreFoundation.")
        return result

    def request_accessibility(self):
        key = ctypes.c_void_p.in_dll(self.ax, "kAXTrustedCheckOptionPrompt")
        value = ctypes.c_void_p.in_dll(self.cf, "kCFBooleanTrue")
        key_callbacks = ctypes.addressof(
            ctypes.c_byte.in_dll(self.cf, "kCFTypeDictionaryKeyCallBacks")
        )
        value_callbacks = ctypes.addressof(
            ctypes.c_byte.in_dll(self.cf, "kCFTypeDictionaryValueCallBacks")
        )
        options = self.cf.CFDictionaryCreate(
            None,
            ctypes.byref(key),
            ctypes.byref(value),
            1,
            key_callbacks,
            value_callbacks,
        )
        if not options:
            raise AccessError("Не удалось создать параметры запроса Accessibility.")
        try:
            return bool(self.ax.AXIsProcessTrustedWithOptions(options))
        finally:
            self.cf.CFRelease(options)

    def attribute(self, element, name, required=False):
        key = self.string(name)
        result = ctypes.c_void_p()
        try:
            error = self.ax.AXUIElementCopyAttributeValue(
                element, key, ctypes.byref(result)
            )
        finally:
            self.cf.CFRelease(key)
        if error:
            if required or error not in (-25205, -25212):
                raise AccessError(f"Не удалось прочитать {name}: AXError {error}.")
            return None
        if result.value:
            self.retained.append(result.value)
        return result.value

    def scalar(self, value):
        if value is None:
            return None
        kind = self.cf.CFGetTypeID(value)
        if kind == self.cf.CFBooleanGetTypeID():
            return bool(self.cf.CFBooleanGetValue(value))
        if kind != self.cf.CFStringGetTypeID():
            return None
        length = self.cf.CFStringGetLength(value)
        if length > 4096:
            return "[Строка длиннее 4096 символов]"
        size = self.cf.CFStringGetMaximumSizeForEncoding(length, self.UTF8) + 1
        buffer = ctypes.create_string_buffer(size)
        if not self.cf.CFStringGetCString(value, buffer, size, self.UTF8):
            raise AccessError("Не удалось прочитать строку Accessibility.")
        return buffer.value.decode("utf-8")

    def inspect(self, pid, max_depth, max_nodes):
        try:
            os.kill(pid, 0)
        except OSError as error:
            raise AccessError("Указанный процесс недоступен.") from error
        app = self.ax.AXUIElementCreateApplication(pid)
        if not app:
            raise AccessError("Не удалось получить приложение Accessibility.")
        self.retained.append(app)
        error = self.ax.AXUIElementSetMessagingTimeout(app, 2.0)
        if error:
            raise AccessError(f"Не удалось задать тайм-аут: AXError {error}.")
        frontmost = self.scalar(self.attribute(app, "AXFrontmost", required=True))
        window = self.attribute(app, "AXFocusedWindow", required=True)
        if not window:
            raise AccessError("У процесса нет окна с фокусом.")
        window_pid = ctypes.c_int()
        error = self.ax.AXUIElementGetPid(window, ctypes.byref(window_pid))
        if error or window_pid.value != pid:
            raise AccessError("Окно не принадлежит указанному процессу.")

        nodes = []
        elements = []
        truncated = False
        attributes = {
            "role": "AXRole",
            "subrole": "AXSubrole",
            "title": "AXTitle",
            "description": "AXDescription",
            "value": "AXValue",
            "enabled": "AXEnabled",
            "modal": "AXModal",
        }

        def visit(element, path, depth, ancestors):
            nonlocal truncated
            if len(nodes) >= max_nodes:
                truncated = True
                return
            if any(self.cf.CFEqual(element, parent) for parent in ancestors):
                return
            node = {"path": path}
            for label, attribute in attributes.items():
                value = self.scalar(self.attribute(element, attribute))
                if value is not None:
                    node[label] = value
            nodes.append(node)
            elements.append(element)
            children = self.attribute(element, "AXChildren")
            if not children or self.cf.CFGetTypeID(children) != self.cf.CFArrayGetTypeID():
                return
            count = self.cf.CFArrayGetCount(children)
            if depth >= max_depth:
                truncated = truncated or count > 0
                return
            for index in range(count):
                if len(nodes) >= max_nodes:
                    truncated = True
                    break
                child = self.cf.CFArrayGetValueAtIndex(children, index)
                visit(child, f"{path}.{index}", depth + 1, ancestors + [element])

        visit(window, "0", 0, [])
        return frontmost, nodes, elements, truncated, app, window

    def press(self, element, app, window, expected_name):
        if self.scalar(self.attribute(app, "AXFrontmost", required=True)) is not True:
            raise AccessError("Окно тестового процесса больше не на переднем плане.")
        focused_window = self.attribute(app, "AXFocusedWindow", required=True)
        if not focused_window or not self.cf.CFEqual(focused_window, window):
            raise AccessError("Окно с фокусом изменилось после чтения дерева.")
        role = self.scalar(self.attribute(element, "AXRole", required=True))
        title = self.scalar(self.attribute(element, "AXTitle"))
        description = self.scalar(self.attribute(element, "AXDescription"))
        if role not in ("AXButton", "AXPopUpButton") or expected_name not in (
            title,
            description,
        ):
            raise AccessError("Кнопка изменилась после чтения дерева.")
        if self.scalar(self.attribute(element, "AXEnabled", required=True)) is not True:
            raise AccessError(f"Кнопка «{expected_name}» больше недоступна.")
        action = self.string("AXPress")
        try:
            error = self.ax.AXUIElementPerformAction(element, action)
        finally:
            self.cf.CFRelease(action)
        if error:
            raise AccessError(f"Не удалось нажать кнопку: AXError {error}.")

    def close(self):
        for value in reversed(self.retained):
            self.cf.CFRelease(value)


def main():
    parser = JsonArgumentParser(
        description="Проверяем только окно с фокусом указанного процесса Chrome."
    )
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument("--check", action="store_true", help="Проверить доступ без запроса.")
    operation.add_argument(
        "--request-accessibility",
        action="store_true",
        help="Показать штатный запрос доступа macOS Accessibility.",
    )
    operation.add_argument("--snapshot", action="store_true", help="Прочитать дерево окна.")
    operation.add_argument("--press", metavar="NAME", help="Нажать кнопку с точным именем.")
    parser.add_argument("--pid", type=int, help="PID тестового процесса Chrome.")
    parser.add_argument("--max-depth", type=int, default=12)
    parser.add_argument("--max-nodes", type=int, default=500)
    args = parser.parse_args()
    api = None
    try:
        api = Accessibility()
        trusted = bool(api.ax.AXIsProcessTrusted())
        if args.check:
            return {"ok": True, "trusted": trusted}
        if args.request_accessibility:
            return {
                "ok": True,
                "trusted": api.request_accessibility(),
                "promptRequested": True,
            }
        if not trusted:
            raise AccessError("Accessibility недоступен. Разрешите доступ в настройках macOS.")
        if not args.pid or args.pid <= 0:
            raise AccessError("Укажите положительный --pid тестового процесса Chrome.")
        if not 1 <= args.max_depth <= 20 or not 1 <= args.max_nodes <= 1000:
            raise AccessError("Допустимы глубина 1–20 и число узлов 1–1000.")
        frontmost, nodes, elements, truncated, app, window = api.inspect(
            args.pid, args.max_depth, args.max_nodes
        )
        result = {
            "ok": True,
            "pid": args.pid,
            "frontmost": frontmost,
            "truncated": truncated,
            "nodes": nodes,
        }
        if args.press is not None:
            if not frontmost:
                raise AccessError("Окно тестового процесса не на переднем плане.")
            if truncated:
                raise AccessError("Дерево обрезано: нельзя подтвердить единственность кнопки.")
            matches = [
                index
                for index, node in enumerate(nodes)
                if node.get("role") in ("AXButton", "AXPopUpButton")
                and args.press in (node.get("title"), node.get("description"))
            ]
            if len(matches) != 1:
                raise AccessError(f"Нужна ровно одна кнопка «{args.press}»; найдено {len(matches)}.")
            index = matches[0]
            if nodes[index].get("enabled") is not True:
                raise AccessError(f"Кнопка «{args.press}» недоступна.")
            api.press(elements[index], app, window, args.press)
            result = {"ok": True, "pid": args.pid, "pressed": args.press, "path": nodes[index]["path"]}
        return result
    finally:
        if api is not None:
            api.close()


if __name__ == "__main__":
    try:
        output = main()
    except (AccessError, OSError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        sys.exit(1)
    print(json.dumps(output, ensure_ascii=False))
