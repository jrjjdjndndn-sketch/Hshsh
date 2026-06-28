@file:OptIn(ExperimentalStdlibApi::class)

package com.lo.aiplayer.viewmodel

import android.app.Application
import android.content.Intent
import android.graphics.Bitmap
import android.media.projection.MediaProjectionManager
import android.provider.Settings
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.lo.aiplayer.data.local.SettingsDataStore
import com.lo.aiplayer.data.local.UserSettings
import com.lo.aiplayer.data.model.GameAction
import com.lo.aiplayer.data.model.GameProfile
import com.lo.aiplayer.data.remote.GeminiRepository
import com.lo.aiplayer.service.GameAccessibilityService
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class GameViewModel @Inject constructor(
    private val application: Application,
    private val settingsDataStore: SettingsDataStore,
    private val geminiRepository: GeminiRepository
) : ViewModel() {

    private val _uiState = MutableStateFlow(UiState())
    val uiState: StateFlow<UiState> = _uiState.asStateFlow()

    private var aiLoopJob: Job? = null
    private val actionHistory = mutableListOf<GameAction>()

    fun testApiKey(apiKey: String, model: String, onResult: (String) -> Unit) {
        viewModelScope.launch {
            val result = geminiRepository.testApiKey(apiKey, model)
            onResult(result.getOrElse { it.message ?: "Unknown error" })
        }
    }

    init {
        viewModelScope.launch {
            settingsDataStore.settingsFlow.collect { settings ->
                _uiState.value = _uiState.value.copy(settings = settings)
            }
        }
    }

    fun saveApiKey(key: String) {
        viewModelScope.launch { settingsDataStore.saveApiKey(key) }
    }

    fun saveModel(model: String) {
        viewModelScope.launch { settingsDataStore.saveModel(model) }
    }

    fun addProfile(profile: GameProfile) {
        viewModelScope.launch { settingsDataStore.addProfile(profile) }
    }

    fun updateProfile(index: Int, profile: GameProfile) {
        viewModelScope.launch { settingsDataStore.updateProfile(index, profile) }
    }

    fun deleteProfile(index: Int) {
        viewModelScope.launch { settingsDataStore.deleteProfile(index) }
    }

    fun selectProfile(index: Int) {
        viewModelScope.launch { settingsDataStore.selectProfile(index) }
    }

    fun requestProjectionIntent(): Intent {
        val manager = application.getSystemService(MediaProjectionManager::class.java)
        return manager.createScreenCaptureIntent()
    }

    fun openAccessibilitySettings() {
        val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        application.startActivity(intent)
    }

    fun startAiLoop(frameProvider: suspend () -> Bitmap?) {
        if (aiLoopJob?.isActive == true) return
        _uiState.value = _uiState.value.copy(isRunning = true, lastError = null)

        aiLoopJob = viewModelScope.launch {
            val settings = _uiState.value.settings
            val profile = settings.selectedProfile

            while (true) {
                val bitmap = frameProvider() ?: run {
                    delay(500)
                    continue
                }

                val result = geminiRepository.decideAction(
                    apiKey = settings.apiKey,
                    model = settings.model,
                    profile = profile,
                    screenshot = bitmap,
                    screenWidth = bitmap.width,
                    screenHeight = bitmap.height,
                    recentHistory = actionHistory.takeLast(5)
                )

                result.onSuccess { action ->
                    GameAccessibilityService.instance?.executeAction(action)
                    actionHistory.add(action)
                    if (actionHistory.size > 20) actionHistory.removeAt(0)
                    _uiState.value = _uiState.value.copy(
                        lastAction = action,
                        lastError = null
                    )
                }.onFailure { error ->
                    _uiState.value = _uiState.value.copy(lastError = error.message)
                }

                delay(profile.intervalMs)
            }
        }
    }

    fun stopAiLoop() {
        aiLoopJob?.cancel()
        aiLoopJob = null
        _uiState.value = _uiState.value.copy(isRunning = false)
    }

    override fun onCleared() {
        super.onCleared()
        stopAiLoop()
    }
}

data class UiState(
    val settings: UserSettings = UserSettings("", "", listOf(GameProfile("", "", "")), 0),
    val isRunning: Boolean = false,
    val lastAction: GameAction? = null,
    val lastError: String? = null
)
