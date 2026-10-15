package local.pannelhandle.bridge

import com.intellij.execution.RunManager
import com.intellij.execution.RunnerAndConfigurationSettings
import com.intellij.execution.compound.CompoundRunConfigurationType
import com.intellij.execution.configurations.ConfigurationTypeUtil
import com.intellij.execution.executors.DefaultRunExecutor
import com.intellij.execution.process.ProcessHandler
import com.intellij.openapi.util.Disposer
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.util.ui.UIUtil
import com.google.gson.JsonParser
import java.io.OutputStream
import java.lang.reflect.InvocationTargetException
import java.net.Socket
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.ExecutorService

class IdeaBridgeServiceTest : BasePlatformTestCase() {
    private lateinit var bridge: IdeaBridgeService

    override fun setUp() {
        super.setUp()
        bridge = IdeaBridgeService()
    }

    override fun tearDown() {
        try {
            Disposer.dispose(bridge)
        } finally {
            super.tearDown()
        }
    }

    fun testStopAfterConfigurationDeleted() {
        val handler = registerDeletedConfigurationExecution()

        invokeBridge("stopExecution", "instance")

        assertEquals(1, handler.destroyCount)
        // Repeated stops remain harmless while termination is in progress.
        invokeBridge("stopExecution", "instance")
        assertEquals(1, handler.destroyCount)
    }

    fun testSnapshotAfterConfigurationDeletedKeepsStopTarget() {
        val (settings, handler) = registerConfigurationExecution()
        RunManager.getInstance(project).removeConfiguration(settings)
        val operation = IdeaBridgeService::class.java.getDeclaredMethod(
            "projectSnapshot", com.intellij.openapi.project.Project::class.java,
        ).apply { isAccessible = true }
        fun snapshot() = operation.invoke(bridge, project) as ProjectSnapshot
        val configuration = snapshot().configurations.single { it.id == settings.uniqueID }
        assertFalse(configuration.supportsRun)
        assertFalse(configuration.supportsDebug)
        assertEquals(settings.name, configuration.name)
        val instance = configuration.instances.single()
        assertEquals("instance", instance.id)
        assertEquals("running", instance.status)
        invokeBridge("stopExecution", instance.id)
        assertEquals(1, handler.destroyCount)
        assertEquals("stopping", snapshot().configurations.single { it.id == settings.uniqueID }.instances.single().status)
    }

    fun testRestartAfterConfigurationDeleted() {
        val handler = registerDeletedConfigurationExecution()

        val error = expectNotFound("restartExecution", "instance")

        assertEquals("The IDEA run configuration no longer exists", error.message)
        assertEquals(0, handler.destroyCount)
    }

    fun testStopUnknownInstance() {
        val error = expectNotFound("stopExecution", "missing")
        assertEquals("The IDEA execution instance no longer exists", error.message)
    }

    fun testStartWithRetainedTerminatedInstance() {
        val (settings, handler) = registerConfigurationExecution()
        handler.terminate()

        // Keep the record in activeExecutions, just as during the three-second grace period.
        invokeStart(settings)
    }

    fun testStartWithRunningInstanceIsRejected() {
        val (settings, _) = registerConfigurationExecution()
        assertStartRejected(settings)
    }

    fun testStartWithStoppingInstanceIsRejected() {
        val (settings, handler) = registerConfigurationExecution()
        handler.destroyProcess()
        assertTrue(handler.isProcessTerminating)
        assertStartRejected(settings)
    }

    private fun invokeStart(settings: RunnerAndConfigurationSettings) {
        val projectId = IdeaBridgeService::class.java.getDeclaredMethod("projectId", com.intellij.openapi.project.Project::class.java)
            .apply { isAccessible = true }.invoke(bridge, project) as String
        val operation = IdeaBridgeService::class.java.getDeclaredMethod(
            "startConfiguration", String::class.java, String::class.java, String::class.java,
        ).apply { isAccessible = true }
        try {
            operation.invoke(bridge, projectId, settings.uniqueID, "run")
        } catch (error: InvocationTargetException) {
            throw error.targetException
        }
    }

    private fun assertStartRejected(settings: RunnerAndConfigurationSettings) {
        try {
            invokeStart(settings)
            fail("Expected non-parallel start to be rejected")
        } catch (error: IllegalStateException) {
            assertEquals("${settings.name} does not allow parallel execution", error.message)
        }
    }

    fun testIdleUnauthenticatedClientsDoNotStarveMaintenance() {
        val path = bridgeField("discoveryPath") as Path
        val discovery = JsonParser.parseString(Files.readString(path)).asJsonObject
        val port = discovery.get("port").asInt
        val authenticated = Socket("127.0.0.1", port).apply { soTimeout = 2_000 }
        val idle = List(5) { Socket("127.0.0.1", port).apply { soTimeout = 2_000 } }
        try {
            val reader = authenticated.getInputStream().bufferedReader()
            authenticated.getOutputStream().bufferedWriter().apply {
                write("""{"type":"auth","protocolVersion":1,"token":"${discovery.get("token").asString}"}""")
                newLine()
                flush()
            }
            assertTrue(JsonParser.parseString(reader.readLine()).asJsonObject.get("ok").asBoolean)
            // Observe production heartbeat intervals for longer than Electron's 20-second expiry.
            var updatedAt = discovery.get("updatedAt").asLong
            repeat(5) { interval ->
                awaitCondition(7_000) {
                    JsonParser.parseString(Files.readString(path)).asJsonObject.get("updatedAt").asLong > updatedAt
                }
                updatedAt = JsonParser.parseString(Files.readString(path)).asJsonObject.get("updatedAt").asLong
                IdeaBridgeService::class.java.getDeclaredMethod("scheduleSnapshotBroadcast")
                    .apply { isAccessible = true }.invoke(bridge)
                awaitCondition(3_000) { reader.ready() }
                assertEquals("snapshotChanged", JsonParser.parseString(reader.readLine()).asJsonObject.get("event").asString)
                if (interval == 1) {
                    idle.forEach { assertEquals("Unauthenticated socket must time out", -1, it.getInputStream().read()) }
                }
            }
        } finally {
            authenticated.close()
            idle.forEach(Socket::close)
        }
    }

    fun testDisposeClosesPendingAuthenticationAndExecutors() {
        val discovery = JsonParser.parseString(Files.readString(bridgeField("discoveryPath") as Path)).asJsonObject
        Socket("127.0.0.1", discovery.get("port").asInt).use { socket ->
            socket.soTimeout = 2_000
            awaitCondition(2_000) {
                synchronized(bridgeField("socketLock")) { (bridgeField("sockets") as Set<*>).isNotEmpty() }
            }
            bridge.dispose()
            assertEquals(-1, socket.getInputStream().read())
            listOf("scheduler", "ioExecutor").forEach {
                val executor = bridgeField(it) as ExecutorService
                assertTrue(executor.isShutdown)
                awaitCondition(2_000) { executor.isTerminated }
            }
            assertFalse(Files.exists(bridgeField("discoveryPath") as Path))
        }
    }

    private fun bridgeField(name: String): Any = IdeaBridgeService::class.java.getDeclaredField(name)
        .apply { isAccessible = true }.get(bridge)

    private fun awaitCondition(timeoutMillis: Long, condition: () -> Boolean) {
        val deadline = System.nanoTime() + timeoutMillis * 1_000_000
        while (!condition()) {
            if (System.nanoTime() >= deadline) fail("Condition did not complete within $timeoutMillis ms")
            UIUtil.dispatchAllInvocationEvents()
            Thread.sleep(10)
        }
    }

    private fun registerDeletedConfigurationExecution(): RecordingProcessHandler {
        val (settings, handler) = registerConfigurationExecution()
        val manager = RunManager.getInstance(project)
        manager.removeConfiguration(settings)
        assertFalse(manager.allSettings.any { it.uniqueID == settings.uniqueID })
        return handler
    }

    private fun registerConfigurationExecution(): Pair<RunnerAndConfigurationSettings, RecordingProcessHandler> {
        val manager = RunManager.getInstance(project)
        val settings = manager.createConfiguration(
            "deleted configuration",
            ConfigurationTypeUtil.findConfigurationType(CompoundRunConfigurationType::class.java).configurationFactories.first(),
        )
        manager.addConfiguration(settings)
        settings.configuration.isAllowRunningInParallel = false
        val handler = RecordingProcessHandler().apply { startNotify() }
        // Seed the listener's retained execution record with a real project and handler.
        val executionClass = Class.forName("local.pannelhandle.bridge.ActiveExecution")
        val constructor = executionClass.declaredConstructors.single().apply { isAccessible = true }
        val execution = constructor.newInstance(
            "instance", project, settings.uniqueID, settings.name,
            DefaultRunExecutor.getRunExecutorInstance(), handler, 1L, System.currentTimeMillis(),
        )
        val field = IdeaBridgeService::class.java.getDeclaredField("activeExecutions").apply { isAccessible = true }
        @Suppress("UNCHECKED_CAST")
        val executions = field.get(bridge) as MutableMap<String, Any>
        executions["instance"] = execution
        return settings to handler
    }

    private fun invokeBridge(method: String, instanceId: String) {
        val operation = IdeaBridgeService::class.java.getDeclaredMethod(method, String::class.java)
            .apply { isAccessible = true }
        try {
            operation.invoke(bridge, instanceId)
        } catch (error: InvocationTargetException) {
            throw error.targetException
        }
    }

    private fun expectNotFound(method: String, instanceId: String): NoSuchElementException {
        try {
            invokeBridge(method, instanceId)
            fail("Expected the operation to reject the missing resource")
        } catch (error: NoSuchElementException) {
            val errorCode = IdeaBridgeService::class.java.getDeclaredMethod("errorCode", Exception::class.java)
                .apply { isAccessible = true }
            assertEquals("NOT_FOUND", errorCode.invoke(bridge, error))
            return error
        }
        throw AssertionError("Expected NOT_FOUND")
    }

    private class RecordingProcessHandler : ProcessHandler() {
        var destroyCount = 0
            private set

        override fun destroyProcessImpl() { destroyCount++ }
        override fun detachProcessImpl() { notifyProcessDetached() }
        override fun detachIsDefault() = false
        override fun getProcessInput(): OutputStream? = null

        fun terminate() { notifyProcessTerminated(0) }
    }
}
