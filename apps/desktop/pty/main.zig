const std = @import("std");
const builtin = @import("builtin");

const c = if (builtin.os.tag == .linux)
    @cImport({
        @cInclude("pty.h");
        @cInclude("unistd.h");
        @cInclude("sys/ioctl.h");
        @cInclude("sys/wait.h");
        @cInclude("signal.h");
        @cInclude("stdlib.h");
    })
else
    @cImport({
        @cInclude("util.h");
        @cInclude("unistd.h");
        @cInclude("sys/ioctl.h");
        @cInclude("sys/wait.h");
        @cInclude("signal.h");
        @cInclude("stdlib.h");
    });

const MessageType = enum {
    spawn,
    input,
    resize,
    shutdown,
};

const SpawnPayload = struct {
    shell: []const u8,
    args: []const []const u8,
    cwd: []const u8,
    cols: u32,
    rows: u32,
};

const InputPayload = struct {
    dataBase64: []const u8,
};

const ResizePayload = struct {
    cols: u32,
    rows: u32,
};

const InMessage = struct {
    type: MessageType,
    spawn: ?SpawnPayload = null,
    input: ?InputPayload = null,
    resize: ?ResizePayload = null,
};

const OutDataMessage = struct {
    type: []const u8,
    dataBase64: []const u8,
};

const OutReadyMessage = struct {
    type: []const u8,
};

const OutExitMessage = struct {
    type: []const u8,
    exitCode: i32,
    signal: i32,
};

const OutErrorMessage = struct {
    type: []const u8,
    message: []const u8,
};

var gpa = std.heap.GeneralPurposeAllocator(.{}){};
var alloc: std.mem.Allocator = undefined;

var stdout_mutex = std.Thread.Mutex{};
var output_thread: ?std.Thread = null;
var stop_output = std.atomic.Value(bool).init(false);
var master_fd: ?std.posix.fd_t = null;
var child_pid: ?std.posix.pid_t = null;

fn sendJson(value: anytype) !void {
    stdout_mutex.lock();
    defer stdout_mutex.unlock();
    const json_text = try std.fmt.allocPrint(alloc, "{f}\n", .{std.json.fmt(value, .{})});
    defer alloc.free(json_text);
    try writeAll(std.posix.STDOUT_FILENO, json_text);
}

fn sendError(text: []const u8) void {
    sendJson(OutErrorMessage{ .type = "error", .message = text }) catch {};
}

fn sendReady() void {
    sendJson(OutReadyMessage{ .type = "ready" }) catch {};
}

fn sendExit(exit_code: i32, signal_code: i32) void {
    sendJson(OutExitMessage{
        .type = "exit",
        .exitCode = exit_code,
        .signal = signal_code,
    }) catch {};
}

fn encodeBase64Alloc(input: []const u8) ![]u8 {
    const size = std.base64.standard.Encoder.calcSize(input.len);
    const out = try alloc.alloc(u8, size);
    _ = std.base64.standard.Encoder.encode(out, input);
    return out;
}

fn decodeBase64Alloc(input: []const u8) ![]u8 {
    const size = try std.base64.standard.Decoder.calcSizeForSlice(input);
    const out = try alloc.alloc(u8, size);
    try std.base64.standard.Decoder.decode(out, input);
    return out;
}

fn outputLoop() void {
    var local_exit_code: i32 = 0;
    var local_signal: i32 = 0;
    defer {
        sendExit(local_exit_code, local_signal);
        if (master_fd) |fd| {
            std.posix.close(fd);
            master_fd = null;
        }
        child_pid = null;
    }

    while (!stop_output.load(.seq_cst)) {
        const fd = master_fd orelse break;
        var buf: [4096]u8 = undefined;
        const n = std.posix.read(fd, &buf) catch |err| switch (err) {
            else => break,
        };
        if (n == 0) break;

        const encoded = encodeBase64Alloc(buf[0..n]) catch {
            sendError("failed to base64-encode PTY chunk");
            continue;
        };
        defer alloc.free(encoded);

        sendJson(OutDataMessage{ .type = "data", .dataBase64 = encoded }) catch {};
    }

    if (child_pid) |pid| {
        var status: c_int = 0;
        _ = c.waitpid(pid, &status, 0);
        if (c.WIFEXITED(status)) {
            local_exit_code = c.WEXITSTATUS(status);
        } else if (c.WIFSIGNALED(status)) {
            local_signal = c.WTERMSIG(status);
        }
    }
}

fn shutdownSession() void {
    stop_output.store(true, .seq_cst);

    if (child_pid) |pid| {
        _ = c.kill(@intCast(pid), c.SIGTERM);
    }

    if (master_fd) |fd| {
        std.posix.close(fd);
        master_fd = null;
    }

    if (output_thread) |thread| {
        thread.join();
        output_thread = null;
    }

    child_pid = null;
}

fn writeAll(fd: std.posix.fd_t, data: []const u8) !void {
    var start: usize = 0;
    while (start < data.len) {
        const written = try std.posix.write(fd, data[start..]);
        if (written == 0) return error.WriteFailed;
        start += written;
    }
}

fn handleSpawn(payload: SpawnPayload) !void {
    if (master_fd != null or child_pid != null) {
        shutdownSession();
    }

    var ws = c.struct_winsize{
        .ws_row = @intCast(payload.rows),
        .ws_col = @intCast(payload.cols),
        .ws_xpixel = 0,
        .ws_ypixel = 0,
    };

    var local_master: c_int = 0;
    const pid = c.forkpty(&local_master, null, null, &ws);
    if (pid < 0) {
        return error.ForkPtyFailed;
    }

    if (pid == 0) {
        const cwd_z = try alloc.dupeZ(u8, payload.cwd);
        _ = c.chdir(cwd_z.ptr);

        _ = c.setenv("TERM", "xterm-256color", 1);
        _ = c.setenv("COLORTERM", "truecolor", 1);
        _ = c.setenv("TERM_PROGRAM", "pixel-agents", 1);
        _ = c.setenv("TERM_PROGRAM_VERSION", "desktop-zig", 1);

        const shell_z = try alloc.dupeZ(u8, payload.shell);

        const arg_count = payload.args.len + 2;
        const argv = try alloc.alloc(?[*:0]u8, arg_count);
        argv[0] = shell_z.ptr;
        var i: usize = 0;
        while (i < payload.args.len) : (i += 1) {
            const z = try alloc.dupeZ(u8, payload.args[i]);
            argv[i + 1] = z.ptr;
        }
        argv[arg_count - 1] = null;

        _ = c.execvp(shell_z.ptr, @ptrCast(argv.ptr));
        c._exit(127);
    }

    master_fd = @intCast(local_master);
    child_pid = @intCast(pid);
    stop_output.store(false, .seq_cst);

    output_thread = try std.Thread.spawn(.{}, outputLoop, .{});
    sendReady();
}

fn handleInput(payload: InputPayload) !void {
    const fd = master_fd orelse return;
    const decoded = try decodeBase64Alloc(payload.dataBase64);
    defer alloc.free(decoded);
    try writeAll(fd, decoded);
}

fn handleResize(payload: ResizePayload) void {
    if (master_fd) |fd| {
        var ws = c.struct_winsize{
            .ws_row = @intCast(payload.rows),
            .ws_col = @intCast(payload.cols),
            .ws_xpixel = 0,
            .ws_ypixel = 0,
        };
        _ = c.ioctl(@intCast(fd), c.TIOCSWINSZ, &ws);
    }
}

pub fn main() !void {
    alloc = gpa.allocator();
    defer {
        shutdownSession();
        _ = gpa.deinit();
    }

    var input_accumulator = std.ArrayList(u8).empty;
    defer input_accumulator.deinit(alloc);
    var read_buf: [4096]u8 = undefined;
    while (true) {
        const read_len = std.posix.read(std.posix.STDIN_FILENO, &read_buf) catch |err| switch (err) {
            else => {
                const text = std.fmt.allocPrint(alloc, "stdin read failed: {s}", .{@errorName(err)}) catch {
                    sendError("failed to read stdin");
                    break;
                };
                defer alloc.free(text);
                sendError(text);
                break;
            },
        };
        if (read_len == 0) break;
        try input_accumulator.appendSlice(alloc, read_buf[0..read_len]);

        while (std.mem.indexOfScalar(u8, input_accumulator.items, '\n')) |newline_index| {
            const raw_line = input_accumulator.items[0..newline_index];
            const line = std.mem.trim(u8, raw_line, " \r\n\t");
            if (line.len > 0) {
                var parsed = std.json.parseFromSlice(InMessage, alloc, line, .{}) catch {
                    sendError("invalid JSON message");
                    const tail = input_accumulator.items[newline_index + 1 ..];
                    std.mem.copyForwards(u8, input_accumulator.items[0..tail.len], tail);
                    input_accumulator.items.len = tail.len;
                    continue;
                };
                defer parsed.deinit();

                const msg = parsed.value;
                switch (msg.type) {
                    .spawn => {
                        if (msg.spawn) |payload| {
                            handleSpawn(payload) catch |err| {
                                const text = std.fmt.allocPrint(alloc, "spawn failed: {s}", .{@errorName(err)}) catch {
                                    sendError("spawn failed");
                                    continue;
                                };
                                defer alloc.free(text);
                                sendError(text);
                            };
                        } else {
                            sendError("spawn payload missing");
                        }
                    },
                    .input => {
                        if (msg.input) |payload| {
                            handleInput(payload) catch |err| {
                                const text = std.fmt.allocPrint(alloc, "input failed: {s}", .{@errorName(err)}) catch {
                                    sendError("input failed");
                                    continue;
                                };
                                defer alloc.free(text);
                                sendError(text);
                            };
                        }
                    },
                    .resize => {
                        if (msg.resize) |payload| {
                            handleResize(payload);
                        }
                    },
                    .shutdown => {
                        shutdownSession();
                        return;
                    },
                }
            }

            const tail = input_accumulator.items[newline_index + 1 ..];
            std.mem.copyForwards(u8, input_accumulator.items[0..tail.len], tail);
            input_accumulator.items.len = tail.len;
            if (input_accumulator.items.len > 1024 * 1024) {
                sendError("input accumulator overflow");
                input_accumulator.clearRetainingCapacity();
                break;
            }
        }

        if (input_accumulator.items.len > 1024 * 1024) {
            sendError("input accumulator overflow");
            input_accumulator.clearRetainingCapacity();
        }
    }
}
