package local.pannelhandle.bridge

import com.intellij.execution.RunManager
import com.intellij.execution.compound.CompoundRunConfigurationType
import com.intellij.execution.configurations.ConfigurationTypeUtil
import com.intellij.execution.executors.DefaultRunExecutor
import com.intellij.execution.process.ProcessHandler
import com.intellij.openapi.util.Disposer
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.io.OutputStream
import java.lang.reflect.InvocationTargetException

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

    private fun registerDeletedConfigurationExecution(): RecordingProcessHandler {
        val manager = RunManager.getInstance(project)
        val settings = manager.createConfiguration(
            "deleted configuration",
            ConfigurationTypeUtil.findConfigurationType(CompoundRunConfigurationType::class.java).configurationFactories.first(),
        )
        manager.addConfiguration(settings)
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
        manager.removeConfiguration(settings)
        assertFalse(manager.allSettings.any { it.uniqueID == settings.uniqueID })
        return handler
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
    }
}
