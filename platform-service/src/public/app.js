/**
 * CloudOps — Cloud-Based Application Testing & Deployment Platform
 * Frontend Application Controller
 */

(function () {
  'use strict';

  // Application State
  const state = {
    token: localStorage.getItem('cloudops_token') || null,
    user: null,
    organization: null,
    membership: null,
    projects: [],
    activeProjectId: localStorage.getItem('cloudops_active_project') || null,
    activeProject: null,
    liveDeployment: null,
    connections: [],
    authConfig: { googleClientId: '', googleEnabled: false },
    activeView: 'overview',
    stepperInterval: null,
    isDeploying: false
  };

  // Toast Notifications
  function notify(message, type = 'info', duration = 4500) {
    const area = document.getElementById('notification-area');
    if (!area) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const icon = type === 'success' ? '✔' : type === 'error' ? '✖' : 'ℹ';
    toast.innerHTML = `<span>${icon}</span> <span>${escapeHtml(message)}</span>`;

    area.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(20px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Centralized API Client
  async function api(endpoint, options = {}) {
    const headers = {
      'Accept': 'application/json',
      ...(options.headers || {})
    };

    if (!(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }

    if (state.token) {
      headers['Authorization'] = `Bearer ${state.token}`;
      headers['x-auth-token'] = state.token;
    }

    try {
      const res = await fetch(endpoint, {
        ...options,
        headers
      });

      if (res.status === 401 && !endpoint.includes('/api/auth/login') && !endpoint.includes('/api/auth/signup') && !endpoint.includes('/api/auth/google')) {
        // Token expired or invalid
        clearSession();
        notify('Session expired. Please sign in again.', 'info');
        updateUI();
        throw new Error('Authentication required');
      }

      const isJson = res.headers.get('content-type')?.includes('application/json');
      const data = isJson ? await res.json() : await res.text();

      if (!res.ok) {
        const errorMsg = data?.message || data?.error || `Request failed with status ${res.status}`;
        const err = new Error(errorMsg);
        err.status = res.status;
        err.data = data;
        throw err;
      }

      return data;
    } catch (err) {
      throw err;
    }
  }

  // Session Management
  function setSession(authData) {
    if (!authData) return;
    state.token = authData.token;
    state.user = authData.user;
    state.organization = authData.organization;
    state.membership = authData.membership;

    if (authData.token) {
      localStorage.setItem('cloudops_token', authData.token);
      document.cookie = `session_token=${encodeURIComponent(authData.token)}; path=/; max-age=${3 * 86400}; SameSite=Lax`;
    }

    updateUI();
  }

  function clearSession() {
    state.token = null;
    state.user = null;
    state.organization = null;
    state.membership = null;
    localStorage.removeItem('cloudops_token');
    document.cookie = 'session_token=; path=/; max-age=0';
  }

  async function restoreSession() {
    // Check URL hash for OAuth redirect token handoff
    const hash = window.location.hash;
    if (hash && hash.includes('auth_token=')) {
      const tokenMatch = hash.match(/auth_token=([^&]+)/);
      if (tokenMatch && tokenMatch[1]) {
        state.token = decodeURIComponent(tokenMatch[1]);
        localStorage.setItem('cloudops_token', state.token);
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      }
    }

    try {
      const res = await api('/api/auth/config');
      state.authConfig = {
        googleClientId: res.googleClientId || '',
        googleEnabled: res.googleEnabled === true
      };
      if (res.googleClientId) {
        setupGoogleIdentity(res.googleClientId);
      }
    } catch (e) {
      console.warn('[CloudOps] Auth config error:', e);
    }

    if (!state.token) {
      updateUI();
      return;
    }

    try {
      const me = await api('/api/auth/me');
      setSession(me);
      await loadAllData();
    } catch (err) {
      clearSession();
      updateUI();
    }
  }

  // Google Identity Services (GIS)
  function setupGoogleIdentity(clientId) {
    if (!clientId) return;
    const checkGsi = setInterval(() => {
      if (window.google && window.google.accounts && window.google.accounts.id) {
        clearInterval(checkGsi);
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: handleGoogleCredentialResponse,
          auto_select: false,
          cancel_on_tap_outside: true
        });

        const loginTarget = document.getElementById('gis-button-login');
        if (loginTarget) {
          window.google.accounts.id.renderButton(loginTarget, {
            theme: 'outline',
            size: 'large',
            width: 320,
            text: 'continue_with'
          });
        }
      }
    }, 200);
    setTimeout(() => clearInterval(checkGsi), 5000);
  }

  async function handleGoogleCredentialResponse(response) {
    if (!response || !response.credential) {
      notify('Google authentication cancelled', 'error');
      return;
    }
    try {
      notify('Verifying Google credentials with CloudOps...', 'info');
      const res = await api('/api/auth/google', {
        method: 'POST',
        body: JSON.stringify({ credential: response.credential })
      });
      setSession(res);
      closeModals();
      notify(`Welcome, ${state.user?.name || state.user?.email}!`, 'success');
      await loadAllData();
    } catch (err) {
      notify(`Google login failed: ${err.message}`, 'error');
    }
  }

  function triggerGoogleLogin() {
    if (!state.authConfig?.googleEnabled || !state.authConfig?.googleClientId) {
      notify('Google OAuth is not configured. Please sign in with email.', 'error');
      return;
    }
    if (window.google && window.google.accounts && window.google.accounts.id) {
      window.google.accounts.id.prompt((notification) => {
        if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
          window.location.href = '/api/auth/google';
        }
      });
    } else {
      window.location.href = '/api/auth/google';
    }
  }

  // View Navigation
  function switchView(viewName) {
    state.activeView = viewName;

    // Update nav items
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === viewName);
    });

    // Update panels
    document.querySelectorAll('.view-panel').forEach(panel => {
      panel.classList.toggle('active', panel.id === `view-${viewName}`);
    });

    // Update topbar title
    const titles = {
      overview: 'Platform Overview',
      projects: 'Application Projects',
      environments: 'Testing Environments',
      connections: 'Provider Connections',
      settings: 'Workspace Settings'
    };
    const crumbs = {
      overview: 'Dashboard / Application Testing',
      projects: 'Projects / Deployments',
      environments: 'AWS EC2 / Compute Hosts',
      connections: 'Settings / Cloud Providers',
      settings: 'Account / Workspace Settings'
    };

    const topTitle = document.getElementById('topbar-view-title');
    const topCrumb = document.getElementById('topbar-view-crumb');
    if (topTitle) topTitle.textContent = titles[viewName] || 'CloudOps';
    if (topCrumb) topCrumb.textContent = crumbs[viewName] || 'Application Testing';

    // Refresh view data
    if (viewName === 'overview') refreshOverview();
    if (viewName === 'projects') renderProjectsView();
    if (viewName === 'environments') renderEnvironmentsView();
    if (viewName === 'connections') refreshConnections();
  }

  // Data Loading
  async function loadAllData() {
    await Promise.allSettled([
      fetchProjects(),
      fetchConnections(),
      refreshAWSStatus(),
      refreshDockerStatus()
    ]);
    refreshOverview();
    renderProjectsView();
    renderEnvironmentsView();
  }

  async function fetchProjects() {
    try {
      const res = await api('/api/projects');
      state.projects = res.projects || [];

      // Update count badge
      const badge = document.getElementById('nav-project-count');
      if (badge) badge.textContent = state.projects.length;

      // Maintain active project selection
      if (state.projects.length > 0) {
        if (!state.activeProjectId || !state.projects.some(p => p.projectId === state.activeProjectId || p.id === state.activeProjectId)) {
          state.activeProjectId = state.projects[0].projectId || state.projects[0].id;
        }
        state.activeProject = state.projects.find(p => p.projectId === state.activeProjectId || p.id === state.activeProjectId) || state.projects[0];
        localStorage.setItem('cloudops_active_project', state.activeProjectId);
      } else {
        state.activeProjectId = null;
        state.activeProject = null;
      }

      updateProjectSelectDropdown();
      if (state.activeProject) {
        await fetchLiveDeployment(state.activeProject.projectId || state.activeProject.id);
      }
    } catch (err) {
      console.warn('[CloudOps] Failed to fetch projects:', err.message);
    }
  }

  async function fetchLiveDeployment(projectId) {
    if (!projectId) return;
    try {
      const res = await api(`/api/projects/${projectId}/deployments/live`);
      if (res && res.live && res.deployment) {
        state.liveDeployment = res.deployment;
      } else {
        state.liveDeployment = null;
      }
    } catch {
      state.liveDeployment = null;
    }
  }

  async function fetchConnections() {
    try {
      const res = await api('/api/connections');
      state.connections = res.connections || [];
    } catch {
      state.connections = [];
    }
  }

  async function refreshAWSStatus() {
    try {
      const status = await api('/api/aws/status');
      updateAWSConnectionUI(status);
      return status;
    } catch (err) {
      updateAWSConnectionUI({ connected: false, message: err.message });
      return { connected: false };
    }
  }

  async function refreshDockerStatus() {
    try {
      const res = await api('/api/agent/status');
      updateDockerConnectionUI(res);
      return res;
    } catch {
      updateDockerConnectionUI({ connected: false });
      return { connected: false };
    }
  }

  // UI Updates
  function updateUI() {
    const isLoggedIn = !!state.user;

    // Header buttons
    const authGroup = document.getElementById('auth-buttons-group');
    const tenantGroup = document.getElementById('tenant-badges-group');
    if (authGroup) authGroup.classList.toggle('hidden', isLoggedIn);
    if (tenantGroup) tenantGroup.classList.toggle('hidden', !isLoggedIn);

    // Sidebar User
    const userName = document.getElementById('sidebar-user-name');
    const userEmail = document.getElementById('sidebar-user-email');
    const orgName = document.getElementById('sidebar-org-name');
    const orgBadge = document.getElementById('topbar-org-badge');
    const roleBadge = document.getElementById('sidebar-role-badge');
    const logoutBtn = document.getElementById('btn-sidebar-logout');

    if (userName) userName.textContent = state.user?.name || 'Developer';
    if (userEmail) userEmail.textContent = state.user?.email || 'Not signed in';
    if (orgName) orgName.textContent = state.organization?.name || 'My Workspace';
    if (orgBadge) orgBadge.textContent = `🏢 ${state.organization?.name || 'Workspace'}`;
    if (roleBadge) roleBadge.textContent = state.membership?.role || 'GUEST';
    if (logoutBtn) logoutBtn.title = isLoggedIn ? 'Sign Out' : 'Sign In';

    // Settings Profile
    const sName = document.getElementById('settings-user-name');
    const sEmail = document.getElementById('settings-user-email');
    const sProvider = document.getElementById('settings-user-provider');
    const sOrg = document.getElementById('settings-org-name');
    const sOrgId = document.getElementById('settings-org-id');
    const sRole = document.getElementById('settings-role-badge');

    if (sName) sName.textContent = state.user?.name || '-';
    if (sEmail) sEmail.textContent = state.user?.email || '-';
    if (sProvider) sProvider.textContent = state.user?.provider === 'google' ? 'Google OAuth 2.0' : 'Email & Password';
    if (sOrg) sOrg.textContent = state.organization?.name || '-';
    if (sOrgId) sOrgId.textContent = state.organization?.id || '-';
    if (sRole) sRole.textContent = state.membership?.role || 'MEMBER';

    // Google card in Connections
    const gPill = document.getElementById('card-google-status-pill');
    const gUser = document.getElementById('card-google-user');
    const gClient = document.getElementById('card-google-client-id');
    if (gPill) {
      gPill.className = `status-pill ${isLoggedIn && state.user?.provider === 'google' ? 'pill-running' : 'pill-stopped'}`;
      gPill.textContent = isLoggedIn && state.user?.provider === 'google' ? '● AUTHENTICATED' : '○ NOT SIGNED IN';
    }
    if (gUser) gUser.textContent = state.user?.email || 'Not signed in';
    if (gClient) gClient.textContent = state.authConfig?.googleClientId ? 'Configured' : 'Missing GOOGLE_CLIENT_ID';
  }

  function updateProjectSelectDropdown() {
    const select = document.getElementById('global-project-select');
    if (!select) return;

    select.innerHTML = '';
    if (state.projects.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No Projects Uploaded';
      select.appendChild(opt);
      return;
    }

    state.projects.forEach(p => {
      const opt = document.createElement('option');
      const pid = p.projectId || p.id;
      opt.value = pid;
      opt.textContent = p.name || p.project?.name || `Project ${pid.slice(0, 8)}`;
      if (pid === state.activeProjectId) opt.selected = true;
      select.appendChild(opt);
    });
  }

  function updateAWSConnectionUI(status) {
    const isConn = status && status.connected === true;
    const cardPill = document.getElementById('card-aws-status-pill');
    const cardAcc = document.getElementById('card-aws-account');
    const cardReg = document.getElementById('card-aws-region');
    const cardKey = document.getElementById('card-aws-masked-key');
    const ovPill = document.getElementById('overview-conn-aws-pill');
    const ovSub = document.getElementById('overview-conn-aws-sub');

    if (cardPill) {
      cardPill.className = `status-pill ${isConn ? 'pill-running' : 'pill-stopped'}`;
      cardPill.textContent = isConn ? '● CONNECTED' : '○ NOT CONNECTED';
    }
    if (cardAcc) cardAcc.textContent = status.accountId || 'Not Configured';
    if (cardReg) cardReg.textContent = status.region || 'ap-south-1';

    const awsConn = state.connections.find(c => c.provider === 'AWS');
    if (cardKey) cardKey.textContent = awsConn?.metadata?.maskedAccessKey || (isConn ? 'Configured (Active)' : '****');

    if (ovPill) {
      ovPill.className = `status-pill ${isConn ? 'pill-running' : 'pill-stopped'}`;
      ovPill.textContent = isConn ? '● Connected' : '○ Disconnected';
    }
    if (ovSub) {
      ovSub.textContent = isConn ? `Account: ${status.accountId || 'Verified'} (${status.region})` : 'Access Key & Secret Key Required';
    }
  }

  function updateDockerConnectionUI(status) {
    const isConn = status && (status.connected === true || status.status === 'ONLINE' || status.available === true);
    const cardPill = document.getElementById('card-docker-status-pill');
    const cardDaemon = document.getElementById('card-docker-daemon');
    const cardVer = document.getElementById('card-docker-version');
    const cardOs = document.getElementById('card-docker-os');
    const ovPill = document.getElementById('overview-conn-docker-pill');
    const ovSub = document.getElementById('overview-conn-docker-sub');

    if (cardPill) {
      cardPill.className = `status-pill ${isConn ? 'pill-running' : 'pill-stopped'}`;
      cardPill.textContent = isConn ? '● CONNECTED' : '○ DISCONNECTED';
    }
    if (cardDaemon) cardDaemon.textContent = isConn ? 'Running (Active)' : 'Not Running';
    if (cardVer) cardVer.textContent = status.dockerStatus?.version || status.version || 'Docker Engine';
    if (cardOs) cardOs.textContent = status.machineInfo?.os || status.operatingSystem || 'Docker Host';

    if (ovPill) {
      ovPill.className = `status-pill ${isConn ? 'pill-running' : 'pill-stopped'}`;
      ovPill.textContent = isConn ? '● Connected' : '○ Disconnected';
    }
    if (ovSub) {
      ovSub.textContent = isConn ? 'Daemon active for cross-arch builds' : 'Docker daemon offline';
    }
  }

  // ============================================================
  // VIEW RENDERERS
  // ============================================================

  // 1. Overview Renderer
  async function refreshOverview() {
    // 1. Top Metrics
    const metricProj = document.getElementById('metric-projects-count');
    const metricEnv = document.getElementById('metric-environments-count');
    const metricHealth = document.getElementById('metric-health-status');

    if (metricProj) metricProj.textContent = state.projects.length;

    const hasLiveEnv = !!(state.liveDeployment && state.liveDeployment.isLive);
    if (metricEnv) metricEnv.textContent = hasLiveEnv ? '1' : '0';
    if (metricHealth) {
      metricHealth.textContent = hasLiveEnv
        ? (state.liveDeployment.healthCheckStatus === 'healthy' ? 'Healthy ✓' : 'Unhealthy')
        : (state.projects.length > 0 ? 'Ready to Test' : 'No Active Env');
    }

    // 2. Active Environment Card
    const appNameEl = document.getElementById('overview-active-app-name');
    const envPill = document.getElementById('overview-env-status-pill');
    const ec2InfoEl = document.getElementById('overview-ec2-info');
    const containerStatusEl = document.getElementById('overview-container-status');
    const portInfoEl = document.getElementById('overview-port-info');
    const healthCheckStatusEl = document.getElementById('overview-health-check-status');
    const publicUrlText = document.getElementById('overview-public-url-text');
    const openUrlBtn = document.getElementById('btn-overview-open-url');
    const copyUrlBtn = document.getElementById('btn-overview-copy-url');

    const dep = state.liveDeployment;
    const proj = state.activeProject;

    if (dep && dep.isLive) {
      const url = dep.publicUrl || dep.endpoint || `http://${dep.publicIp}:${dep.port || 3000}`;
      if (appNameEl) appNameEl.textContent = proj?.name || dep.projectName || 'Active Application';
      if (envPill) {
        envPill.className = 'status-pill pill-running';
        envPill.textContent = '● RUNNING';
      }
      if (ec2InfoEl) ec2InfoEl.textContent = `${dep.ec2InstanceId || 'EC2'} (${dep.awsRegion || 'ap-south-1'})`;
      if (containerStatusEl) containerStatusEl.textContent = 'Running (Docker via SSM)';
      if (portInfoEl) portInfoEl.textContent = `${dep.port || 3000} (HTTP)`;
      if (healthCheckStatusEl) healthCheckStatusEl.textContent = dep.healthCheckStatus === 'healthy' ? 'Healthy (HTTP 200)' : 'Check Failed';
      if (publicUrlText) publicUrlText.textContent = url;
      if (openUrlBtn) {
        openUrlBtn.href = url;
        openUrlBtn.classList.remove('hidden');
      }
      if (copyUrlBtn) copyUrlBtn.classList.remove('hidden');
    } else {
      if (appNameEl) appNameEl.textContent = proj ? (proj.name || 'Application Ready') : 'No Application Deployed';
      if (envPill) {
        envPill.className = 'status-pill pill-stopped';
        envPill.textContent = '○ NOT DEPLOYED';
      }
      if (ec2InfoEl) ec2InfoEl.textContent = 'AWS EC2';
      if (containerStatusEl) containerStatusEl.textContent = 'Not Running';
      if (portInfoEl) portInfoEl.textContent = '3000 (HTTP)';
      if (healthCheckStatusEl) healthCheckStatusEl.textContent = 'Pending';
      if (publicUrlText) publicUrlText.textContent = 'http://no-instance-running';
      if (openUrlBtn) openUrlBtn.classList.add('hidden');
      if (copyUrlBtn) copyUrlBtn.classList.add('hidden');
    }

    // 3. Recent Projects Table
    const tbody = document.getElementById('tbody-overview-projects');
    if (tbody) {
      tbody.innerHTML = '';
      if (state.projects.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="empty-cell">No projects uploaded yet. Upload an application ZIP to begin testing.</td></tr>';
      } else {
        state.projects.slice(0, 5).forEach(p => {
          const tr = document.createElement('tr');
          const isLive = p.liveStatus === 'LIVE' || (p.liveDeploymentId && state.liveDeployment?.id === p.liveDeploymentId);
          const pName = escapeHtml(p.name || p.project?.name || 'Application');
          const pStatus = isLive ? '<span class="status-pill pill-running">● Healthy</span>' : '<span class="status-pill pill-stopped">○ Idle</span>';
          const pEnv = isLive ? 'AWS EC2' : 'None';
          const pTime = p.uploadedAt ? formatRelativeTime(p.uploadedAt) : 'Recently';

          tr.innerHTML = `
            <td><strong>${pName}</strong></td>
            <td>${pStatus}</td>
            <td>${pEnv}</td>
            <td style="color: var(--text-muted);">${pTime}</td>
          `;
          tr.style.cursor = 'pointer';
          tr.onclick = () => {
            selectActiveProject(p.projectId || p.id);
            switchView('projects');
          };
          tbody.appendChild(tr);
        });
      }
    }
  }

  // 2. Projects Renderer
  function renderProjectsView() {
    const proj = state.activeProject;
    const dep = state.liveDeployment;

    // Banner
    const bannerTitle = document.getElementById('project-banner-title');
    const bannerStatus = document.getElementById('project-banner-status');
    const bannerDesc = document.getElementById('project-banner-desc');
    const btnRedeploy = document.getElementById('btn-project-redeploy');
    const btnLogs = document.getElementById('btn-project-logs');
    const btnStop = document.getElementById('btn-project-stop');
    const btnOpen = document.getElementById('btn-project-open');

    if (proj) {
      const isLive = !!(dep && dep.isLive);
      if (bannerTitle) bannerTitle.textContent = proj.name || proj.project?.name || 'Uploaded Application';
      if (bannerStatus) {
        bannerStatus.className = `status-pill ${isLive ? 'pill-running' : 'pill-stopped'}`;
        bannerStatus.textContent = isLive ? '● RUNNING' : '○ READY TO DEPLOY';
      }
      if (bannerDesc) {
        const runtime = proj.runtime || proj.project?.runtime || 'Node.js';
        const port = proj.port?.value || proj.port || 3000;
        bannerDesc.textContent = `Runtime: ${runtime} | Port: ${port} | Workspace isolated testing target`;
      }

      if (btnRedeploy) btnRedeploy.classList.remove('hidden');
      if (btnLogs) btnLogs.classList.remove('hidden');
      if (btnStop) btnStop.classList.toggle('hidden', !isLive);
      if (btnOpen) {
        if (isLive && (dep.publicUrl || dep.endpoint)) {
          btnOpen.href = dep.publicUrl || dep.endpoint;
          btnOpen.classList.remove('hidden');
        } else {
          btnOpen.classList.add('hidden');
        }
      }
    } else {
      if (bannerTitle) bannerTitle.textContent = 'Upload an Application ZIP';
      if (bannerStatus) {
        bannerStatus.className = 'status-pill pill-neutral';
        bannerStatus.textContent = 'NO PROJECT';
      }
      if (bannerDesc) bannerDesc.textContent = 'Select a ZIP file below to inspect, build, and deploy your testing environment.';
      if (btnRedeploy) btnRedeploy.classList.add('hidden');
      if (btnLogs) btnLogs.classList.add('hidden');
      if (btnStop) btnStop.classList.add('hidden');
      if (btnOpen) btnOpen.classList.add('hidden');
    }

    // Projects Table
    renderAllProjectsTable();

    // Stepper State
    if (!state.isDeploying) {
      updateStepperFromProject();
    }
  }

  function renderAllProjectsTable() {
    const tbody = document.getElementById('tbody-all-projects');
    const countEl = document.getElementById('projects-table-count');
    if (!tbody) return;

    if (countEl) countEl.textContent = `${state.projects.length} project${state.projects.length === 1 ? '' : 's'}`;
    tbody.innerHTML = '';

    if (state.projects.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-cell">No applications uploaded yet. Upload a ZIP file above to begin.</td></tr>';
      return;
    }

    state.projects.forEach(p => {
      const tr = document.createElement('tr');
      const pid = p.projectId || p.id;
      const isActive = pid === state.activeProjectId;
      const isLive = p.liveStatus === 'LIVE' || (p.liveDeploymentId && state.liveDeployment?.id === p.liveDeploymentId);
      const url = p.liveUrl || p.liveEndpoint || (isLive ? state.liveDeployment?.publicUrl : null);
      const pName = escapeHtml(p.name || p.project?.name || `Project ${pid.slice(0, 8)}`);
      const runtime = escapeHtml(p.runtime || p.project?.runtime || 'Node.js');
      const port = p.port?.value || p.port || 3000;
      const pTime = p.uploadedAt ? formatRelativeTime(p.uploadedAt) : 'Recently';

      tr.className = isActive ? 'row-active' : '';
      tr.innerHTML = `
        <td><strong>${pName}</strong> ${isActive ? '<span class="tenant-role-badge">ACTIVE</span>' : ''}</td>
        <td><span class="badge-subtle">${runtime}</span></td>
        <td><code>${port}</code></td>
        <td>${isLive ? '<span class="status-pill pill-running">● Healthy</span>' : '<span class="status-pill pill-stopped">○ Idle</span>'}</td>
        <td>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="code-pill">${escapeHtml(url)}</a>` : '<span style="color: var(--text-muted);">-</span>'}</td>
        <td style="color: var(--text-muted); font-size: 0.75rem;">${pTime}</td>
        <td>
          <div style="display: flex; gap: 0.35rem;">
            <button type="button" class="btn btn-secondary btn-sm" onclick="App.selectActiveProject('${pid}')">Select</button>
            <button type="button" class="btn btn-primary btn-sm" onclick="App.triggerDeploy('${pid}')">Deploy</button>
            <button type="button" class="btn btn-danger btn-sm" onclick="App.deleteProject('${pid}')" title="Delete">🗑</button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  function updateStepperFromProject() {
    const proj = state.activeProject;
    const dep = state.liveDeployment;
    const liveBox = document.getElementById('project-live-url-box');
    const liveUrlText = document.getElementById('project-live-url-text');
    const liveOpenBtn = document.getElementById('btn-project-live-open');
    const liveTimeEl = document.getElementById('project-live-timestamp');

    if (dep && dep.isLive) {
      setStepperStage(6);
      const url = dep.publicUrl || dep.endpoint || `http://${dep.publicIp}:${dep.port || 3000}`;
      if (liveBox) liveBox.classList.remove('hidden');
      if (liveUrlText) liveUrlText.textContent = url;
      if (liveOpenBtn) liveOpenBtn.href = url;
      if (liveTimeEl) liveTimeEl.textContent = dep.updatedAt ? `Deployed ${formatRelativeTime(dep.updatedAt)}` : 'Live';
    } else if (proj) {
      setStepperStage(1);
      if (liveBox) liveBox.classList.add('hidden');
    } else {
      resetStepper();
      if (liveBox) liveBox.classList.add('hidden');
    }
  }

  function setStepperStage(stageNumber) {
    for (let i = 1; i <= 6; i++) {
      const step = document.getElementById(`step-${i}`);
      const line = document.getElementById(`line-${i}`);
      if (!step) continue;

      step.classList.remove('completed', 'active', 'failed');
      if (line) line.classList.remove('completed');

      if (i < stageNumber) {
        step.classList.add('completed');
        if (line) line.classList.add('completed');
      } else if (i === stageNumber) {
        if (stageNumber === 6) {
          step.classList.add('completed');
        } else {
          step.classList.add('active');
        }
      }
    }
  }

  function resetStepper() {
    for (let i = 1; i <= 6; i++) {
      const step = document.getElementById(`step-${i}`);
      const line = document.getElementById(`line-${i}`);
      if (step) step.classList.remove('completed', 'active', 'failed');
      if (line) line.classList.remove('completed');
    }
  }

  // 3. Environments Renderer
  function renderEnvironmentsView() {
    const dep = state.liveDeployment;
    const envPill = document.getElementById('env-status-pill');
    const ec2Id = document.getElementById('env-ec2-id');
    const ec2State = document.getElementById('env-ec2-state');
    const ec2Type = document.getElementById('env-ec2-type');
    const ec2Arch = document.getElementById('env-ec2-arch');
    const ec2Reg = document.getElementById('env-ec2-region');
    const ec2Ip = document.getElementById('env-ec2-public-ip');
    const contStatus = document.getElementById('env-container-status');
    const contId = document.getElementById('env-container-id');
    const imgTag = document.getElementById('env-image-tag');
    const portEl = document.getElementById('env-port');
    const healthStatus = document.getElementById('env-health-status');
    const healthUrl = document.getElementById('env-health-url');
    const healthCode = document.getElementById('env-health-code');
    const healthTime = document.getElementById('env-health-time');
    const publicUrlText = document.getElementById('env-public-url-text');
    const openUrlBtn = document.getElementById('btn-env-open-url');
    const copyUrlBtn = document.getElementById('btn-env-copy-url');

    if (dep && dep.isLive) {
      const url = dep.publicUrl || dep.endpoint || `http://${dep.publicIp}:${dep.port || 3000}`;
      if (envPill) {
        envPill.className = 'status-pill pill-running';
        envPill.textContent = '● RUNNING';
      }
      if (ec2Id) ec2Id.textContent = dep.ec2InstanceId || dep.ec2?.instanceId || 'i-configured';
      if (ec2State) ec2State.textContent = 'running';
      if (ec2Type) ec2Type.textContent = dep.ec2InstanceType || dep.ec2?.instanceType || 't3.micro';
      if (ec2Arch) ec2Arch.textContent = dep.ec2Architecture || 'x86_64';
      if (ec2Reg) ec2Reg.textContent = dep.awsRegion || 'ap-south-1';
      if (ec2Ip) ec2Ip.textContent = dep.publicIp || dep.host || 'Reachable';

      if (contStatus) contStatus.textContent = 'Running';
      if (contId) contId.textContent = dep.containerId ? dep.containerId.slice(0, 12) : 'active';
      if (imgTag) imgTag.textContent = dep.imageTag || 'cloudops:latest';
      if (portEl) portEl.textContent = dep.port || 3000;

      if (healthStatus) healthStatus.textContent = dep.healthCheckStatus === 'healthy' ? 'Healthy ✓' : 'Degraded';
      if (healthUrl) healthUrl.textContent = `${url}/health`;
      if (healthCode) healthCode.textContent = 'HTTP 200 OK';
      if (healthTime) healthTime.textContent = dep.updatedAt ? formatRelativeTime(dep.updatedAt) : 'Just now';

      if (publicUrlText) publicUrlText.textContent = url;
      if (openUrlBtn) {
        openUrlBtn.href = url;
        openUrlBtn.classList.remove('hidden');
      }
      if (copyUrlBtn) copyUrlBtn.classList.remove('hidden');
    } else {
      if (envPill) {
        envPill.className = 'status-pill pill-stopped';
        envPill.textContent = '○ STOPPED';
      }
      if (ec2Id) ec2Id.textContent = 'None';
      if (ec2State) ec2State.textContent = 'Stopped';
      if (ec2Type) ec2Type.textContent = 't3.micro';
      if (ec2Arch) ec2Arch.textContent = 'x86_64';
      if (ec2Reg) ec2Reg.textContent = 'ap-south-1';
      if (ec2Ip) ec2Ip.textContent = 'None';

      if (contStatus) contStatus.textContent = 'Not Running';
      if (contId) contId.textContent = 'None';
      if (imgTag) imgTag.textContent = 'None';
      if (portEl) portEl.textContent = '3000';

      if (healthStatus) healthStatus.textContent = 'Not Running';
      if (healthUrl) healthUrl.textContent = '/health';
      if (healthCode) healthCode.textContent = '-';
      if (healthTime) healthTime.textContent = 'Never';

      if (publicUrlText) publicUrlText.textContent = 'http://no-active-environment';
      if (openUrlBtn) openUrlBtn.classList.add('hidden');
      if (copyUrlBtn) copyUrlBtn.classList.add('hidden');
    }
  }

  // 4. Connections Refresh
  async function refreshConnections() {
    notify('Refreshing provider connections...', 'info', 2000);
    await Promise.allSettled([
      fetchConnections(),
      refreshAWSStatus(),
      refreshDockerStatus()
    ]);
    notify('Provider connection states refreshed.', 'success', 2000);
  }

  // ============================================================
  // DEPLOYMENT WORKFLOW
  // ============================================================

  async function triggerDeploy(projectId) {
    const targetPid = projectId || state.activeProjectId;
    if (!targetPid) {
      notify('Please select or upload a project first', 'error');
      switchView('projects');
      return;
    }

    if (state.isDeploying) {
      notify('Deployment is already in progress', 'info');
      return;
    }

    state.isDeploying = true;
    switchView('projects');
    notify('Starting unified deployment pipeline on AWS EC2...', 'info');

    // Pipeline Stepper Progress
    setStepperStage(2); // Step 2: Build Docker Image

    const pipeStatus = document.getElementById('stepper-pipeline-status');
    if (pipeStatus) pipeStatus.textContent = 'BUILDING DOCKER IMAGE...';

    try {
      // Step 2 to 3 transition
      setTimeout(() => {
        if (state.isDeploying) {
          setStepperStage(3); // Step 3: Deploy to EC2
          if (pipeStatus) pipeStatus.textContent = 'DEPLOYING TO EC2...';
        }
      }, 2500);

      // Step 3 to 4 transition
      setTimeout(() => {
        if (state.isDeploying) {
          setStepperStage(4); // Step 4: Start Container
          if (pipeStatus) pipeStatus.textContent = 'STARTING CONTAINER VIA SSM...';
        }
      }, 5000);

      // Call Unified Backend Deployment
      const deployRes = await api(`/api/projects/${targetPid}/aws/deploy`, {
        method: 'POST',
        body: JSON.stringify({})
      });

      // Step 5: Health Check
      setStepperStage(5);
      if (pipeStatus) pipeStatus.textContent = 'RUNNING REMOTE HEALTH CHECK...';

      // Step 6: Ready
      setStepperStage(6);
      if (pipeStatus) pipeStatus.textContent = 'LIVE & READY';

      state.liveDeployment = deployRes;
      notify(`Test Environment Live! Public URL: ${deployRes.endpoint}`, 'success', 8000);

      // Reload project and views
      await fetchProjects();
      renderProjectsView();
      renderEnvironmentsView();
      refreshOverview();
    } catch (err) {
      console.error('[CloudOps Deploy Error]', err);
      const step = document.querySelector('.stepper-step.active') || document.getElementById('step-2');
      if (step) step.classList.add('failed');
      if (pipeStatus) pipeStatus.textContent = 'DEPLOYMENT FAILED';

      notify(`Deployment failed: ${err.message}`, 'error', 10000);
    } finally {
      state.isDeploying = false;
    }
  }

  // Restart Environment
  async function restartActiveEnvironment() {
    const targetPid = state.activeProjectId;
    if (!targetPid) {
      notify('No active project selected', 'error');
      return;
    }

    notify('Restarting application container on EC2...', 'info');
    try {
      const res = await api(`/api/projects/${targetPid}/aws/restart`, { method: 'POST' });
      notify(`Restart completed: ${res.status}`, 'success');
      await fetchLiveDeployment(targetPid);
      renderEnvironmentsView();
      refreshOverview();
    } catch (err) {
      notify(`Restart failed: ${err.message}`, 'error');
    }
  }

  // Stop Environment
  async function stopActiveEnvironment() {
    const targetPid = state.activeProjectId;
    if (!targetPid) {
      notify('No active project selected', 'error');
      return;
    }

    if (!confirm('Are you sure you want to stop the testing environment container on EC2?')) {
      return;
    }

    notify('Stopping container on EC2...', 'info');
    try {
      await api(`/api/projects/${targetPid}/aws/stop`, { method: 'POST' });
      notify('Testing environment stopped.', 'success');
      state.liveDeployment = null;
      await fetchProjects();
      renderEnvironmentsView();
      renderProjectsView();
      refreshOverview();
    } catch (err) {
      notify(`Stop failed: ${err.message}`, 'error');
    }
  }

  // Delete Project
  async function deleteProject(projectId) {
    if (!confirm('Are you sure you want to delete this project and clean up its resources?')) {
      return;
    }
    try {
      notify('Deleting project...', 'info');
      await api(`/api/projects/${projectId}`, { method: 'DELETE' });
      notify('Project deleted successfully.', 'success');
      if (state.activeProjectId === projectId) {
        state.activeProjectId = null;
        state.activeProject = null;
        state.liveDeployment = null;
      }
      await fetchProjects();
      renderProjectsView();
      refreshOverview();
    } catch (err) {
      notify(`Failed to delete project: ${err.message}`, 'error');
    }
  }

  // View Real Logs
  async function openLogsModal(projectId) {
    const targetPid = projectId || state.activeProjectId;
    if (!targetPid) {
      notify('No active project selected', 'error');
      return;
    }

    const modal = document.getElementById('modal-logs');
    const out = document.getElementById('terminal-log-output');
    const title = document.getElementById('modal-logs-title');
    if (!modal || !out) return;

    if (title) title.textContent = `Deployment Logs (${targetPid.slice(0, 8)})`;
    out.textContent = 'Loading real deployment logs from AWS SSM & Docker...';
    modal.classList.remove('hidden');

    try {
      const logsData = await api(`/api/projects/${targetPid}/aws/logs`);
      const lines = logsData.logs || [];
      if (lines.length === 0) {
        out.textContent = '[info] No deployment logs recorded yet for this project. Trigger a deployment to view build output.';
      } else {
        out.textContent = lines.join('\n');
      }
      // Scroll to bottom
      const terminalBody = out.parentElement;
      if (terminalBody) terminalBody.scrollTop = terminalBody.scrollHeight;
    } catch (err) {
      out.textContent = `[error] Failed to retrieve logs: ${err.message}`;
    }
  }

  // Select Active Project
  function selectActiveProject(projectId) {
    if (!projectId) return;
    state.activeProjectId = projectId;
    state.activeProject = state.projects.find(p => (p.projectId || p.id) === projectId) || null;
    localStorage.setItem('cloudops_active_project', projectId);

    updateProjectSelectDropdown();
    fetchLiveDeployment(projectId).then(() => {
      renderProjectsView();
      renderEnvironmentsView();
      refreshOverview();
    });
  }

  // ============================================================
  // UPLOAD APPLICATION ZIP
  // ============================================================

  async function handleFileUpload(file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.zip')) {
      notify('Only .zip application archives are accepted', 'error');
      return;
    }

    const details = document.getElementById('upload-file-details');
    const nameEl = document.getElementById('upload-detail-name');
    const sizeEl = document.getElementById('upload-detail-size');
    const bar = document.getElementById('upload-progress-bar');
    const valStatus = document.getElementById('upload-val-status');
    const valFiles = document.getElementById('upload-val-files');
    const valRuntime = document.getElementById('upload-val-runtime');
    const valPort = document.getElementById('upload-val-port');

    if (details) details.classList.remove('hidden');
    if (nameEl) nameEl.textContent = file.name;
    if (sizeEl) sizeEl.textContent = formatBytes(file.size);
    if (bar) bar.style.width = '30%';
    if (valStatus) valStatus.textContent = 'Validating ZIP structure & Zip Slip protection...';

    const formData = new FormData();
    formData.append('project', file);

    try {
      notify('Uploading and extracting application ZIP archive...', 'info');
      if (bar) bar.style.width = '60%';

      const res = await api('/api/projects/upload', {
        method: 'POST',
        body: formData
      });

      if (bar) bar.style.width = '100%';
      if (valStatus) valStatus.textContent = 'Validated & Analyzed ✓';

      const analysis = res.analysis || {};
      if (valFiles) valFiles.textContent = `${analysis.uploadMetadata?.fileCount || '-'} files`;
      if (valRuntime) valRuntime.textContent = analysis.project?.runtime || 'Node.js Express';
      if (valPort) valPort.textContent = analysis.port?.value || '3000';

      notify(`Application '${file.name}' uploaded successfully! Ready to deploy to EC2.`, 'success');

      await fetchProjects();
      selectActiveProject(res.projectId);
      setStepperStage(1);
    } catch (err) {
      if (bar) bar.style.width = '0%';
      if (valStatus) valStatus.textContent = 'Upload Failed ✖';
      notify(`Archive upload failed: ${err.message}`, 'error');
    }
  }

  // ============================================================
  // MODAL HANDLERS
  // ============================================================

  function openModal(modalId) {
    const m = document.getElementById(modalId);
    if (m) m.classList.remove('hidden');
  }

  function closeModals() {
    document.querySelectorAll('.modal-overlay').forEach(m => m.classList.add('hidden'));
  }

  function switchToSignup() {
    closeModals();
    openModal('modal-signup');
  }

  function switchToLogin() {
    closeModals();
    openModal('modal-login');
  }

  function copyInstallCommand() {
    const cmd = 'curl -fsSL http://localhost:4000/install.sh | sh';
    navigator.clipboard.writeText(cmd).then(() => notify('Install command copied to clipboard!', 'success'));
  }

  function copyPairingCommand() {
    const el = document.getElementById('agent-pairing-command');
    if (el) {
      navigator.clipboard.writeText(el.textContent.trim()).then(() => notify('Pairing command copied!', 'success'));
    }
  }

  // Helpers
  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  function formatRelativeTime(dateStr) {
    if (!dateStr) return '';
    const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  // ============================================================
  // EVENT LISTENERS INITIALIZATION
  // ============================================================

  document.addEventListener('DOMContentLoaded', () => {
    restoreSession();

    // Nav Item Click
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const view = btn.dataset.view;
        if (view) switchView(view);
      });
    });

    // Mobile Sidebar Toggle
    const sidebarToggle = document.getElementById('sidebar-toggle-btn');
    const sidebar = document.getElementById('app-sidebar');
    if (sidebarToggle && sidebar) {
      sidebarToggle.addEventListener('click', () => {
        sidebar.classList.toggle('mobile-open');
      });
    }

    // Topbar Project Selector
    const projSelect = document.getElementById('global-project-select');
    if (projSelect) {
      projSelect.addEventListener('change', (e) => {
        selectActiveProject(e.target.value);
      });
    }

    // Topbar Auth Buttons
    const btnLogin = document.getElementById('btn-topbar-login');
    const btnSignup = document.getElementById('btn-topbar-signup');
    const btnQuickDeploy = document.getElementById('btn-quick-deploy');
    const btnSidebarLogout = document.getElementById('btn-sidebar-logout');
    const btnSettingsLogout = document.getElementById('btn-settings-logout');

    if (btnLogin) btnLogin.addEventListener('click', () => openModal('modal-login'));
    if (btnSignup) btnSignup.addEventListener('click', () => openModal('modal-signup'));
    if (btnQuickDeploy) btnQuickDeploy.addEventListener('click', () => triggerDeploy());

    const handleLogout = async () => {
      if (!state.token) {
        openModal('modal-login');
        return;
      }
      try {
        await api('/api/auth/logout', { method: 'POST' });
      } catch {}
      clearSession();
      notify('Logged out successfully.', 'info');
      updateUI();
      switchView('overview');
    };

    if (btnSidebarLogout) btnSidebarLogout.addEventListener('click', handleLogout);
    if (btnSettingsLogout) btnSettingsLogout.addEventListener('click', handleLogout);

    // Refresh Overview
    const btnRefreshOv = document.getElementById('btn-refresh-overview');
    if (btnRefreshOv) btnRefreshOv.addEventListener('click', () => loadAllData());

    // Project Deploy Actions
    const btnDeployActive = document.getElementById('btn-deploy-active-project');
    const btnRedeploy = document.getElementById('btn-project-redeploy');
    const btnProjLogs = document.getElementById('btn-project-logs');
    const btnProjStop = document.getElementById('btn-project-stop');

    if (btnDeployActive) btnDeployActive.addEventListener('click', () => triggerDeploy());
    if (btnRedeploy) btnRedeploy.addEventListener('click', () => triggerDeploy());
    if (btnProjLogs) btnProjLogs.addEventListener('click', () => openLogsModal());
    if (btnProjStop) btnProjStop.addEventListener('click', () => stopActiveEnvironment());

    // Overview Card Actions
    const btnOvLogs = document.getElementById('btn-overview-logs');
    const btnOvCopy = document.getElementById('btn-overview-copy-url');
    if (btnOvLogs) btnOvLogs.addEventListener('click', () => openLogsModal());
    if (btnOvCopy) {
      btnOvCopy.addEventListener('click', () => {
        const urlText = document.getElementById('overview-public-url-text')?.textContent;
        if (urlText && !urlText.includes('no-instance')) {
          navigator.clipboard.writeText(urlText).then(() => notify('URL copied to clipboard!', 'success'));
        }
      });
    }

    // Projects Stepper Copy
    const btnProjCopy = document.getElementById('btn-project-live-copy');
    if (btnProjCopy) {
      btnProjCopy.addEventListener('click', () => {
        const urlText = document.getElementById('project-live-url-text')?.textContent;
        if (urlText) {
          navigator.clipboard.writeText(urlText).then(() => notify('URL copied to clipboard!', 'success'));
        }
      });
    }

    // Environments Action Buttons
    const btnEnvLogs = document.getElementById('btn-env-logs');
    const btnEnvRestart = document.getElementById('btn-env-restart');
    const btnEnvStop = document.getElementById('btn-env-stop');
    const btnEnvCopy = document.getElementById('btn-env-copy-url');

    if (btnEnvLogs) btnEnvLogs.addEventListener('click', () => openLogsModal());
    if (btnEnvRestart) btnEnvRestart.addEventListener('click', () => restartActiveEnvironment());
    if (btnEnvStop) btnEnvStop.addEventListener('click', () => stopActiveEnvironment());
    if (btnEnvCopy) {
      btnEnvCopy.addEventListener('click', () => {
        const urlText = document.getElementById('env-public-url-text')?.textContent;
        if (urlText && !urlText.includes('no-url')) {
          navigator.clipboard.writeText(urlText).then(() => notify('URL copied to clipboard!', 'success'));
        }
      });
    }

    // Modal Logs Copy & Refresh
    const btnCopyLogs = document.getElementById('btn-copy-logs');
    const btnRefreshLogs = document.getElementById('btn-refresh-logs');
    if (btnCopyLogs) {
      btnCopyLogs.addEventListener('click', () => {
        const out = document.getElementById('terminal-log-output')?.textContent;
        if (out) navigator.clipboard.writeText(out).then(() => notify('Logs copied!', 'success'));
      });
    }
    if (btnRefreshLogs) {
      btnRefreshLogs.addEventListener('click', () => openLogsModal());
    }

    // File Upload: Drag and Drop & Input
    const dropzone = document.getElementById('upload-dropzone');
    const fileInput = document.getElementById('file-input-project');

    if (dropzone && fileInput) {
      dropzone.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files.length > 0) {
          handleFileUpload(e.target.files[0]);
        }
      });

      ['dragenter', 'dragover'].forEach(eventName => {
        dropzone.addEventListener(eventName, (e) => {
          e.preventDefault();
          dropzone.classList.add('dragover');
        });
      });

      ['dragleave', 'drop'].forEach(eventName => {
        dropzone.addEventListener(eventName, (e) => {
          e.preventDefault();
          dropzone.classList.remove('dragover');
        });
      });

      dropzone.addEventListener('drop', (e) => {
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          handleFileUpload(e.dataTransfer.files[0]);
        }
      });
    }

    // Connections: AWS Management & Verification
    const btnManageAws = document.getElementById('btn-manage-aws');
    const btnTestAws = document.getElementById('btn-test-aws');
    if (btnManageAws) btnManageAws.addEventListener('click', () => openModal('modal-connection'));
    if (btnTestAws) {
      btnTestAws.addEventListener('click', async () => {
        notify('Testing AWS STS GetCallerIdentity...', 'info');
        const st = await refreshAWSStatus();
        if (st.connected) {
          notify(`AWS Connected! Account: ${st.accountId} (${st.region})`, 'success');
        } else {
          notify(`AWS Not Connected: ${st.message || 'Check credentials'}`, 'error');
        }
      });
    }

    // Connections: Docker Test & Agent Pair
    const btnTestDocker = document.getElementById('btn-test-docker');
    const btnPairAgent = document.getElementById('btn-pair-agent');
    if (btnTestDocker) {
      btnTestDocker.addEventListener('click', async () => {
        notify('Probing Docker daemon...', 'info');
        const d = await refreshDockerStatus();
        if (d.connected) {
          notify(`Docker Engine active: ${d.version || 'OK'}`, 'success');
        } else {
          notify('Docker daemon not connected.', 'error');
        }
      });
    }
    if (btnPairAgent) {
      btnPairAgent.addEventListener('click', async () => {
        openModal('modal-pair-agent');
        try {
          const res = await api('/api/agent/pair', { method: 'POST' });
          const codeEl = document.getElementById('agent-pairing-command');
          if (codeEl) codeEl.textContent = `cloudops-agent pair --code ${res.code} --url http://localhost:4000`;
        } catch (e) {
          const codeEl = document.getElementById('agent-pairing-command');
          if (codeEl) codeEl.textContent = 'Failed to generate code: ' + e.message;
        }
      });
    }

    // Form: AWS Connection
    const formConnection = document.getElementById('form-connection');
    if (formConnection) {
      formConnection.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = document.getElementById('conn-field-name')?.value;
        const accessKeyId = document.getElementById('conn-field-access-key')?.value;
        const secretAccessKey = document.getElementById('conn-field-secret-key')?.value;
        const sessionToken = document.getElementById('conn-field-session-token')?.value;
        const region = document.getElementById('conn-field-region')?.value;

        if (!accessKeyId || !secretAccessKey) {
          notify('AWS Access Key ID and Secret Access Key are required', 'error');
          return;
        }

        try {
          notify('Encrypting credentials and saving to vault...', 'info');
          await api('/api/connections', {
            method: 'POST',
            body: JSON.stringify({
              provider: 'AWS',
              name: name || 'AWS Testing Account',
              credentials: {
                accessKeyId,
                secretAccessKey,
                sessionToken: sessionToken || undefined,
                region: region || 'ap-south-1'
              },
              metadata: { region: region || 'ap-south-1' }
            })
          });

          closeModals();
          notify('AWS Credentials saved to encrypted vault. Verifying...', 'success');
          await refreshAWSStatus();
        } catch (err) {
          notify(`Failed to save AWS credentials: ${err.message}`, 'error');
        }
      });
    }

    // Form: Login
    const formLogin = document.getElementById('form-login');
    if (formLogin) {
      formLogin.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('login-email')?.value;
        const password = document.getElementById('login-password')?.value;

        try {
          notify('Signing in...', 'info');
          const res = await api('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email, password })
          });
          setSession(res);
          closeModals();
          notify(`Welcome back, ${res.user.name || res.user.email}!`, 'success');
          await loadAllData();
        } catch (err) {
          notify(`Login failed: ${err.message}`, 'error');
        }
      });
    }

    // Form: Signup
    const formSignup = document.getElementById('form-signup');
    if (formSignup) {
      formSignup.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = document.getElementById('signup-name')?.value;
        const email = document.getElementById('signup-email')?.value;
        const organizationName = document.getElementById('signup-org-name')?.value;
        const password = document.getElementById('signup-password')?.value;

        try {
          notify('Creating workspace and account...', 'info');
          const res = await api('/api/auth/signup', {
            method: 'POST',
            body: JSON.stringify({ name, email, organizationName, password })
          });
          setSession(res);
          closeModals();
          notify('Workspace created successfully!', 'success');
          await loadAllData();
        } catch (err) {
          notify(`Sign up failed: ${err.message}`, 'error');
        }
      });
    }
  });

  // Global App Namespace for Inline Handlers
  window.App = {
    switchView,
    selectActiveProject,
    triggerDeploy,
    deleteProject,
    openLogsModal,
    triggerGoogleLogin,
    switchToSignup,
    switchToLogin,
    closeModals,
    copyInstallCommand,
    copyPairingCommand
  };

})();
