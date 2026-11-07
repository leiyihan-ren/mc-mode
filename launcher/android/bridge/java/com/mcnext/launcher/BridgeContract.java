package com.mcnext.launcher;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/**
 * 由 tools/gen-bridge-contract.cjs 自动生成，请勿手工修改。
 * 与桌面端 electron/preload.cjs 完全同源：只有白名单内的 channel 才会被派发到 JNI / 远程 RPC。
 */
public final class BridgeContract {
    private BridgeContract() {}

    public static final String[] INVOKE_CHANNELS = {
        "repo:listClients",
        "repo:listServers",
        "repo:listLoaderFiles",
        "manifest:fetch",
        "version:getJson",
        "download:start",
        "game:launch",
        "game:stop",
        "game:status",
        "server:detect",
        "server:deploy",
        "server:start",
        "server:stop",
        "server:command",
        "server:status",
        "dialog:pickJar",
        "dialog:pickFile",
        "dialog:pickDir",
        "instance:list",
        "instance:create",
        "instance:info",
        "instance:args",
        "instance:remove",
        "auth:list",
        "auth:deviceStart",
        "auth:deviceBegin",
        "auth:deviceStatus",
        "auth:deviceCancel",
        "auth:deviceComplete",
        "auth:current",
        "auth:select",
        "auth:authlibLogin",
        "auth:authlibMeta",
        "auth:remove",
        "auth:launchArgs",
        "download:batch",
        "modpack:parse",
        "modpack:install",
        "localJar:inspect",
        "localJar:plan",
        "console:highlight",
        "console:highlightBatch",
        "console:parse",
        "crash:analyze",
        "crash:clean",
        "crash:readLatestLog",
        "mobile:export",
        "app:release",
        "app:openExternal",
        "java:scan",
        "java:required",
        "java:select",
        "java:install",
        "lan:binaries",
        "lan:verify",
        "lan:create",
        "lan:join",
        "lan:start",
        "lan:stop",
        "lan:status",
        "lan:listRooms",
        "world:list",
        "world:inspect",
        "world:backups",
        "world:backup",
        "world:restore",
        "skin:inspectFile",
        "skin:fetchFromAuthlib",
        "skin:downloadImage",
        "skin:upload",
        "download:sources",
        "net:guide",
        "net:diagnose",
        "mods:list",
        "mods:conflicts",
        "mods:toggle",
        "mods:packs",
        "mods:shaderCheck",
        "mods:pickPack",
        "mods:import",
        "modpack:parseBuffer",
        "modpack:describe",
        "modpack:preflight",
        "modpack:export",
        "modpack:readManifest",
        "appearance:pickImage",
        "appearance:validate",
        "jvm:profiles",
        "jvm:preview",
        "jvm:monitorStatus",
        "jvm:recommend",
        "modrinth:search",
        "modrinth:versions",
        "modrinth:install",
        "update:check",
        "update:status",
        "update:download"
    };

    public static final String[] EVENT_CHANNELS = {
        "download:progress",
        "download:done",
        "download:error",
        "game:log",
        "game:exit",
        "server:log",
        "server:exit",
        "auth:deviceStatus",
        "download:batch",
        "modpack:progress",
        "java:progress",
        "download:retry",
        "jvm:metrics",
        "modrinth:progress",
        "update:progress"
    };

    public static final String[] NATIVE_CHANNELS = {
        "game:launch",
        "game:stop",
        "game:status",
        "java:scan",
        "app:release",
        "app:openExternal",
        "mobile:export",
        "net:guide",
        "update:check",
        "update:download"
    };

    public static final String[] NATIVE_EVENTS = {
        "game:log",
        "game:exit"
    };

    private static final Set<String> INVOKE_SET = new HashSet<>(Arrays.asList(INVOKE_CHANNELS));
    private static final Set<String> EVENT_SET = new HashSet<>(Arrays.asList(EVENT_CHANNELS));
    private static final Set<String> NATIVE_SET = new HashSet<>(Arrays.asList(NATIVE_CHANNELS));

    public static boolean isKnownInvoke(String channel) { return INVOKE_SET.contains(channel); }
    public static boolean isKnownEvent(String channel) { return EVENT_SET.contains(channel); }
    public static boolean isNative(String channel) { return NATIVE_SET.contains(channel); }

    /** unknown / native / remote */
    public static String classify(String channel) {
        if (!isKnownInvoke(channel)) return "unknown";
        return isNative(channel) ? "native" : "remote";
    }
}
