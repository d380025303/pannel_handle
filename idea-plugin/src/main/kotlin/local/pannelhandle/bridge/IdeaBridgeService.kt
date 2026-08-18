package local.pannelhandle.bridge

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.intellij.execution.DefaultExecutionTarget
import com.intellij.execution.ExecutionListener
import com.intellij.execution.ExecutionManager
import com.intellij.execution.Executor
import com.intellij.execution.ExecutorRegistry
import com.intellij.execution.RunManager
import com.intellij.execution.RunManagerListener
import com.intellij.execution.RunnerAndConfigurationSettings
import com.intellij.execution.executors.DefaultDebugExecutor
import com.intellij.execution.executors.DefaultRunExecutor
import com.intellij.execution.process.ProcessHandler
import com.intellij.execution.runners.ExecutionEnvironment
import com.intellij.execution.runners.ExecutionEnvironmentBuilder
import com.intellij.execution.runners.ProgramRunner
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationInfo
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager
import com.intellij.util.messages.MessageBusConnection
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.AclEntry
import java.nio.file.attribute.AclEntryFlag
import java.nio.file.attribute.AclEntryPermission
import java.nio.file.attribute.AclEntryType
import java.nio.file.attribute.AclFileAttributeView
import java.nio.file.attribute.FileOwnerAttributeView
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.Collections
import java.util.EnumSet
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

private const val PROTOCOL_VERSION = 1
private const val MAX_MESSAGE_CHARS = 1024 * 1024

data class BridgeDiscovery(
    val protocolVersion: Int,
    val bridgeId: String,
    val pid: Long,
    val productName: String,
    val productVersion: String,
    val buildNumber: String,
    val port: Int,
    val token: String,
    val updatedAt: Long,
)

data class BridgeSnapshot(
    val protocolVersion: Int = PROTOCOL_VERSION,
    val bridgeId: String,
    val productName: String,
    val productVersion: String,
    val buildNumber: String,
    val projects: List<ProjectSnapshot>,
)

data class ProjectSnapshot(
    val id: String,
    val name: String,
    val path: String,
    val configurations: List<ConfigurationSnapshot>,
)

data class ConfigurationSnapshot(
    val id: String,
    val name: String,
    val type: String,
    val folderName: String?,
    val temporary: Boolean,
    val allowParallel: Boolean,
    val supportsRun: Boolean,
    val supportsDebug: Boolean,
    val instances: List<ExecutionInstanceSnapshot>,
)

data class ExecutionInstanceSnapshot(
    val id: String,
    val executionId: Long,
    val name: String,
    val mode: String,
    val status: String,
    val startedAt: Long,
)

private data class LocatedExecution(
    val project: Project,
    val settings: RunnerAndConfigurationSettings,
    val executor: Executor,
    val handler: ProcessHandler,
)

private data class ActiveExecution(
    val id: String,
    val project: Project,
    val configurationId: String,
    val configurationName: String,
    val executor: Executor,
    val handler: ProcessHandler,
    val executionId: Long,
    val startedAt: Long,
)

@Service(Service.Level.APP)
class IdeaBridgeService : Disposable {
    private val log = Logger.getInstance(IdeaBridgeService::class.java)
    private val gson = Gson()
    private val bridgeId = randomToken(18)
    private val authToken = randomToken(32)
    private val stopped = AtomicBoolean(false)
    private val serverSocket = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
    private val scheduler = Executors.newScheduledThreadPool(6) { runnable ->
        Thread(runnable, "pannel-handle-idea-bridge").apply { isDaemon = true }
    }
    private val clients = CopyOnWriteArraySet<ClientConnection>()
    private val projectConnections = ConcurrentHashMap<Project, MessageBusConnection>()
    private val activeExecutions = ConcurrentHashMap<String, ActiveExecution>()
    private val pendingBroadcast = AtomicReference<ScheduledFuture<*>?>()
    private val discoveryPath = discoveryDirectory().resolve("$bridgeId.json")

    init {
        writeDiscovery()
        scheduler.scheduleAtFixedRate(::writeDiscoverySafely, 5, 5, TimeUnit.SECONDS)
        scheduler.execute(::acceptConnections)
        ProjectManager.getInstance().openProjects.forEach(::registerProject)
    }

    fun registerProject(project: Project) {
        if (project.isDisposed || projectConnections.containsKey(project)) return
        val connection = project.messageBus.connect(this)
        val executionListener = object : ExecutionListener {
            override fun processStarted(executorId: String, env: ExecutionEnvironment, handler: ProcessHandler) {
                val settings = env.runnerAndConfigurationSettings ?: return
                val id = "${projectId(project)}:${env.executionId}"
                activeExecutions[id] = ActiveExecution(
                    id = id,
                    project = project,
                    configurationId = settings.uniqueID,
                    configurationName = settings.name,
                    executor = env.executor,
                    handler = handler,
                    executionId = env.executionId,
                    startedAt = System.currentTimeMillis(),
                )
                scheduleSnapshotBroadcast()
            }

            override fun processTerminating(executorId: String, env: ExecutionEnvironment, handler: ProcessHandler) {
                scheduleSnapshotBroadcast()
            }

            override fun processTerminated(executorId: String, env: ExecutionEnvironment, handler: ProcessHandler, exitCode: Int) {
                scheduleSnapshotBroadcast()
                scheduler.schedule({
                    activeExecutions.remove("${projectId(project)}:${env.executionId}")
                    scheduleSnapshotBroadcast()
                }, 3, TimeUnit.SECONDS)
            }
        }
        connection.subscribe(ExecutionManager.EXECUTION_TOPIC, executionListener)
        connection.subscribe(RunManagerListener.TOPIC, object : RunManagerListener {
            override fun runConfigurationAdded(settings: RunnerAndConfigurationSettings) = scheduleSnapshotBroadcast()
            override fun runConfigurationRemoved(settings: RunnerAndConfigurationSettings) = scheduleSnapshotBroadcast()
            override fun runConfigurationChanged(settings: RunnerAndConfigurationSettings, existingId: String?) = scheduleSnapshotBroadcast()
        })
        projectConnections[project] = connection
        scheduleSnapshotBroadcast()
    }

    private fun acceptConnections() {
        while (!stopped.get()) {
            try {
                val socket = serverSocket.accept()
                socket.tcpNoDelay = true
                scheduler.execute { handleClient(socket) }
            } catch (error: Exception) {
                if (!stopped.get()) log.warn("IDEA bridge accept failed", error)
            }
        }
    }

    private fun handleClient(socket: Socket) {
        val client = ClientConnection(socket)
        try {
            val authLine = client.reader.readLine() ?: return
            if (authLine.length > MAX_MESSAGE_CHARS) return
            val auth = gson.fromJson(authLine, JsonObject::class.java)
            val valid = auth.get("type")?.asString == "auth" &&
                auth.get("protocolVersion")?.asInt == PROTOCOL_VERSION &&
                auth.get("token")?.asString == authToken
            if (!valid) {
                client.send(mapOf("type" to "auth", "ok" to false, "error" to "Authentication failed"))
                return
            }
            client.authenticated.set(true)
            clients.add(client)
            client.send(mapOf("type" to "auth", "ok" to true, "protocolVersion" to PROTOCOL_VERSION))
            while (!stopped.get()) {
                val line = client.reader.readLine() ?: break
                if (line.length > MAX_MESSAGE_CHARS) throw IllegalArgumentException("Message is too large")
                handleRequest(client, gson.fromJson(line, JsonObject::class.java))
            }
        } catch (error: Exception) {
            if (!stopped.get()) log.info("IDEA bridge client disconnected: ${error.message}")
        } finally {
            clients.remove(client)
            client.close()
        }
    }

    private fun handleRequest(client: ClientConnection, request: JsonObject) {
        val requestId = request.get("requestId")?.asString ?: return
        try {
            if (request.get("type")?.asString != "request") throw IllegalArgumentException("Invalid request type")
            val method = request.get("method")?.asString ?: throw IllegalArgumentException("Method is required")
            val params = request.getAsJsonObject("params") ?: JsonObject()
            val result: Any = when (method) {
                "snapshot" -> buildSnapshot()
                "start" -> {
                    startConfiguration(required(params, "projectId"), required(params, "configurationId"), required(params, "mode"))
                    mapOf("accepted" to true)
                }
                "stop" -> {
                    stopExecution(required(params, "instanceId"))
                    mapOf("accepted" to true)
                }
                "stopAll" -> {
                    val count = stopAll(required(params, "projectId"), required(params, "configurationId"))
                    mapOf("accepted" to true, "count" to count)
                }
                "restart" -> {
                    restartExecution(required(params, "instanceId"))
                    mapOf("accepted" to true)
                }
                else -> throw IllegalArgumentException("Unknown method: $method")
            }
            client.send(mapOf("type" to "response", "requestId" to requestId, "ok" to true, "result" to result))
            if (method != "snapshot") scheduleSnapshotBroadcast()
        } catch (error: Exception) {
            client.send(mapOf(
                "type" to "response",
                "requestId" to requestId,
                "ok" to false,
                "error" to mapOf("code" to errorCode(error), "message" to (error.message ?: "IDEA operation failed")),
            ))
        }
    }

    private fun startConfiguration(projectId: String, configurationId: String, mode: String) = onEdt {
        val project = findProject(projectId)
        val settings = findSettings(project, configurationId)
        val executor = executorFor(mode)
        if (ProgramRunner.getRunner(executor.id, settings.configuration) == null) {
            throw IllegalStateException("${settings.name} does not support ${mode.uppercase()}")
        }
        val running = activeExecutions.values.any { it.project == project && it.configurationId == settings.uniqueID }
        if (!settings.configuration.isAllowRunningInParallel && running) {
            throw IllegalStateException("${settings.name} does not allow parallel execution")
        }
        ExecutionEnvironmentBuilder.create(executor, settings).buildAndExecute()
    }

    private fun stopExecution(instanceId: String) = onEdt {
        val execution = findExecution(instanceId)
        if (!execution.handler.isProcessTerminated && !execution.handler.isProcessTerminating) {
            execution.handler.destroyProcess()
        }
    }

    private fun stopAll(projectId: String, configurationId: String): Int = onEdt {
        val project = findProject(projectId)
        val settings = findSettings(project, configurationId)
        val handlers = activeExecutions.values
            .filter { it.project == project && it.configurationId == settings.uniqueID }
            .map { it.handler }
            .filter { !it.isProcessTerminated && !it.isProcessTerminating }
        handlers.forEach(ProcessHandler::destroyProcess)
        handlers.size
    }

    private fun restartExecution(instanceId: String) = onEdt {
        val execution = findExecution(instanceId)
        ExecutionManager.getInstance(execution.project).restartRunProfile(
            execution.project,
            execution.executor,
            DefaultExecutionTarget.INSTANCE,
            execution.settings,
            execution.handler,
        )
    }

    private fun buildSnapshot(): BridgeSnapshot = onEdt {
        val info = ApplicationInfo.getInstance()
        BridgeSnapshot(
            bridgeId = bridgeId,
            productName = info.versionName,
            productVersion = info.fullVersion,
            buildNumber = info.build.asString(),
            projects = ProjectManager.getInstance().openProjects
                .filter { !it.isDisposed && !it.basePath.isNullOrBlank() }
                .sortedBy { it.name.lowercase() }
                .map(::projectSnapshot),
        )
    }

    private fun projectSnapshot(project: Project): ProjectSnapshot {
        val projectId = projectId(project)
        val manager = RunManager.getInstance(project)
        val configurations = manager.allSettings.mapNotNull { settings ->
            val supportsRun = ProgramRunner.getRunner(DefaultRunExecutor.EXECUTOR_ID, settings.configuration) != null
            val supportsDebug = ProgramRunner.getRunner(DefaultDebugExecutor.EXECUTOR_ID, settings.configuration) != null
            if (!supportsRun && !supportsDebug) return@mapNotNull null
            val executions = activeExecutions.values
                .filter { it.project == project && it.configurationId == settings.uniqueID }
            ConfigurationSnapshot(
                id = settings.uniqueID,
                name = settings.name,
                type = settings.type.displayName,
                folderName = settings.folderName,
                temporary = settings.isTemporary,
                allowParallel = settings.configuration.isAllowRunningInParallel,
                supportsRun = supportsRun,
                supportsDebug = supportsDebug,
                instances = executions.map { execution ->
                    val handler = execution.handler
                    val mode = if (execution.executor.id == DefaultDebugExecutor.EXECUTOR_ID) "debug" else "run"
                    ExecutionInstanceSnapshot(
                        id = execution.id,
                        executionId = execution.executionId,
                        name = execution.configurationName,
                        mode = mode,
                        status = when {
                            handler.isProcessTerminated -> "terminated"
                            handler.isProcessTerminating -> "stopping"
                            handler.isStartNotified -> "running"
                            else -> "starting"
                        },
                        startedAt = execution.startedAt,
                    )
                }.sortedBy { it.startedAt },
            )
        }.sortedWith(compareBy({ it.folderName ?: "" }, { it.name.lowercase() }))
        return ProjectSnapshot(projectId, project.name, project.basePath ?: "", configurations)
    }

    private fun findExecution(instanceId: String): LocatedExecution {
        val execution = activeExecutions[instanceId]
            ?: throw NoSuchElementException("The IDEA execution instance no longer exists")
        if (execution.project.isDisposed) throw NoSuchElementException("The IDEA project is no longer open")
        val settings = findSettings(execution.project, execution.configurationId)
        return LocatedExecution(execution.project, settings, execution.executor, execution.handler)
    }

    private fun findProject(id: String): Project = ProjectManager.getInstance().openProjects.firstOrNull {
        !it.isDisposed && projectId(it) == id
    } ?: throw NoSuchElementException("The IDEA project is no longer open")

    private fun findSettings(project: Project, id: String): RunnerAndConfigurationSettings =
        RunManager.getInstance(project).allSettings.firstOrNull { it.uniqueID == id }
            ?: throw NoSuchElementException("The IDEA run configuration no longer exists")

    private fun executorFor(mode: String): Executor {
        val executorId = when (mode.lowercase()) {
            "run" -> DefaultRunExecutor.EXECUTOR_ID
            "debug" -> DefaultDebugExecutor.EXECUTOR_ID
            else -> throw IllegalArgumentException("Mode must be run or debug")
        }
        return ExecutorRegistry.getInstance().getExecutorById(executorId)
            ?: throw IllegalStateException("IDEA executor is unavailable: $mode")
    }

    private fun scheduleSnapshotBroadcast() {
        pendingBroadcast.getAndSet(scheduler.schedule({
            if (clients.isEmpty()) return@schedule
            try {
                val snapshot = buildSnapshot()
                clients.forEach { it.send(mapOf("type" to "event", "event" to "snapshotChanged", "snapshot" to snapshot)) }
            } catch (error: Exception) {
                if (!stopped.get()) log.warn("Failed to publish IDEA bridge state", error)
            }
        }, 150, TimeUnit.MILLISECONDS))?.cancel(false)
    }

    private fun writeDiscoverySafely() {
        try {
            writeDiscovery()
        } catch (error: Exception) {
            if (!stopped.get()) log.warn("Failed to refresh IDEA bridge discovery", error)
        }
    }

    private fun writeDiscovery() {
        val directory = discoveryPath.parent
        Files.createDirectories(directory)
        restrictToOwner(directory)
        val info = ApplicationInfo.getInstance()
        val discovery = BridgeDiscovery(
            protocolVersion = PROTOCOL_VERSION,
            bridgeId = bridgeId,
            pid = ProcessHandle.current().pid(),
            productName = info.versionName,
            productVersion = info.fullVersion,
            buildNumber = info.build.asString(),
            port = serverSocket.localPort,
            token = authToken,
            updatedAt = System.currentTimeMillis(),
        )
        val temporary = discoveryPath.resolveSibling("${discoveryPath.fileName}.tmp")
        Files.writeString(temporary, gson.toJson(discovery), StandardCharsets.UTF_8)
        restrictToOwner(temporary)
        try {
            Files.move(temporary, discoveryPath, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } catch (_: Exception) {
            Files.move(temporary, discoveryPath, StandardCopyOption.REPLACE_EXISTING)
        }
        restrictToOwner(discoveryPath)
    }

    private fun restrictToOwner(path: Path) {
        try {
            val owner = Files.getFileAttributeView(path, FileOwnerAttributeView::class.java).owner
            val permissions = EnumSet.allOf(AclEntryPermission::class.java)
            val flags = if (Files.isDirectory(path)) {
                EnumSet.of(AclEntryFlag.DIRECTORY_INHERIT, AclEntryFlag.FILE_INHERIT)
            } else {
                Collections.emptySet()
            }
            val entry = AclEntry.newBuilder()
                .setType(AclEntryType.ALLOW)
                .setPrincipal(owner)
                .setPermissions(permissions)
                .setFlags(flags)
                .build()
            Files.getFileAttributeView(path, AclFileAttributeView::class.java)?.acl = listOf(entry)
        } catch (error: Exception) {
            log.warn("Could not restrict IDEA bridge discovery ACL for $path", error)
        }
    }

    private fun discoveryDirectory(): Path {
        val base = System.getenv("LOCALAPPDATA")?.takeIf { it.isNotBlank() }
            ?: System.getProperty("user.home")
        return Path.of(base, "Pannel Handle", "idea-bridge", "instances")
    }

    private fun projectId(project: Project): String {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest((project.basePath ?: project.name).lowercase().toByteArray(StandardCharsets.UTF_8))
        return digest.take(12).joinToString("") { "%02x".format(it) }
    }

    private fun required(params: JsonObject, name: String): String =
        params.get(name)?.takeUnless { it.isJsonNull }?.asString?.takeIf { it.isNotBlank() }
            ?: throw IllegalArgumentException("$name is required")

    private fun errorCode(error: Exception): String = when (error) {
        is NoSuchElementException -> "NOT_FOUND"
        is IllegalArgumentException -> "INVALID_REQUEST"
        is IllegalStateException -> "OPERATION_REJECTED"
        else -> "IDEA_ERROR"
    }

    private fun <T> onEdt(block: () -> T): T {
        val application = ApplicationManager.getApplication()
        if (application.isDispatchThread) return block()
        val result = AtomicReference<T>()
        val failure = AtomicReference<Throwable>()
        application.invokeAndWait {
            try {
                result.set(block())
            } catch (error: Throwable) {
                failure.set(error)
            }
        }
        failure.get()?.let { throw it }
        return result.get()
    }

    override fun dispose() {
        if (!stopped.compareAndSet(false, true)) return
        pendingBroadcast.getAndSet(null)?.cancel(false)
        clients.forEach(ClientConnection::close)
        clients.clear()
        try { serverSocket.close() } catch (_: Exception) { }
        scheduler.shutdownNow()
        try { Files.deleteIfExists(discoveryPath) } catch (error: Exception) { log.warn("Failed to remove IDEA bridge discovery", error) }
    }

    private inner class ClientConnection(private val socket: Socket) {
        val authenticated = AtomicBoolean(false)
        val reader = BufferedReader(InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8))
        private val writer = BufferedWriter(OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8))

        @Synchronized
        fun send(message: Any) {
            if (socket.isClosed) return
            writer.write(gson.toJson(message))
            writer.newLine()
            writer.flush()
        }

        fun close() {
            try { socket.close() } catch (_: Exception) { }
        }
    }

    companion object {
        private fun randomToken(bytes: Int): String {
            val value = ByteArray(bytes)
            SecureRandom().nextBytes(value)
            return Base64.getUrlEncoder().withoutPadding().encodeToString(value)
        }
    }
}
