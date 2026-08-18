package local.pannelhandle.bridge

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.StartupActivity

class BridgeStartupActivity : StartupActivity.DumbAware {
    override fun runActivity(project: Project) {
        ApplicationManager.getApplication().getService(IdeaBridgeService::class.java).registerProject(project)
    }
}
