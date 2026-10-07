
	var data = null;
	var videoPlayer = null;
	var hls = null;
	var jako = "";

	var restartAttempts = 0;
	var MAX_RESTARTS = 4;
	var lastRestartAt = 0;
	var stallTimer = null;
	var restartTimer = null;
	var stallLastTime = -1;
	var stallLastProgressAt = 0;
	var STALL_SECONDS = 20;
	var playStartedAt = 0;
	var lastMediaRecoverAt = 0;
	var tokenExpiresAt = 0;
	var tokenIpTag = "";
	var lastTokenRefreshAt = 0;
	var lastFailure = "";
	var QUALITY_KEY = "sc_quality";

	function fetchJson(url, timeoutMs, onOk, onFail) {
		var request = new XMLHttpRequest();
		request.open('GET', url, true);
		request.timeout = timeoutMs;
		request.onload = function () {
			if (request.status !== 200) { onFail('http-' + request.status); return; }
			var parsed;
			try { parsed = JSON.parse(request.responseText); } catch (e) { onFail('bad-json'); return; }
			onOk(parsed);
		};
		request.onerror = function () { onFail('network'); };
		request.ontimeout = function () { onFail('timeout'); };
		request.send(null);
	}

	function clear(node) {
		while (node.firstChild) node.removeChild(node.firstChild);
	}

	function reload() {
		window.location.reload();
	}

	var libsState = "none";
	var libsWaiting = [];

	function mseAvailable() {
		return !!(window.MediaSource && typeof MediaSource.isTypeSupported === "function");
	}

	function loadScript(url, done, fail) {
		var el = document.createElement("script");
		el.src = url;
		el.onload = done;
		el.onerror = function () { fail(url); };
		document.head.appendChild(el);
	}

	function ensureStreamingLibs(done) {
		if (libsState === "ready" || !mseAvailable()) { done(true); return; }
		libsWaiting.push(done);
		if (libsState === "loading") return;
		libsState = "loading";
		var started = Date.now(), pending = 3, failed = false;
		var finish = function (ok) {
			libsState = ok ? "ready" : "none";
			track(ok ? 'libs_loaded' : 'libs_failed', { ms: Date.now() - started });
			var waiting = libsWaiting; libsWaiting = [];
			for (var k = 0; k < waiting.length; k++) waiting[k](ok);
		};
		var fail = function () { if (!failed) { failed = true; finish(false); } };
		var oneDone = function () {
			if (failed || --pending > 0) return;

			loadScript(SC_LIBS.loader, function () { finish(true); }, fail);
		};
		loadScript(SC_LIBS.hls, oneDone, fail);
		loadScript(SC_LIBS.peer, oneDone, fail);
		loadScript(SC_LIBS.lz, oneDone, fail);
	}

	function startPlayback(isRestart) {
		if (libsState !== "ready" && mseAvailable()) {
			destroyPlayer();
			showPlayerMessage("Loading player\u2026", null, true);
		}
		ensureStreamingLibs(function (ok) {
			if (!ok) { lastFailure = "player-load-failed"; showPlaybackError(); return; }
			startMainVideoPlayback(isRestart);
		});
	}

	function track(name, params) {
		if (window.scTrack) { try { scTrack(name, params); } catch (e) {} }
	}

	function currentStreamInfo() {
		try {
			var ch = data.channelsList[window.currentChannel];
			return { channel: String(ch.caption).slice(0, 60), quality: String(ch.streamsList[window.currentStream].caption).slice(0, 40) };
		} catch (e) { return {}; }
	}

	var channelsToken = "";

	function channelsStatus(text) {
		var box = document.getElementById("channels");
		var old = document.getElementById("channelsStatus");
		if (old) old.parentNode.removeChild(old);
		if (text === null) return;
		var p = document.createElement("p");
		p.setAttribute("id", "channelsStatus");
		p.setAttribute("style", "padding:10px;");
		p.textContent = text;
		box.appendChild(p);
	}

	function channelsLoading() {
		var box = document.getElementById("channels");
		channelsStatus(null);
		var skel = document.createElement("div");
		skel.setAttribute("id", "channelsStatus");
		skel.setAttribute("class", "sc-skeleton");
		skel.setAttribute("role", "status");
		skel.setAttribute("aria-label", "Loading matches");
		for (var i = 0; i < 6; i++) {
			var row = document.createElement("div");
			row.setAttribute("class", "mca_box2");
			var bar = document.createElement("div");
			bar.setAttribute("class", "sc-skel-row");
			row.appendChild(bar);
			skel.appendChild(row);
		}
		box.appendChild(skel);
	}

	function applyToken(token) {
		channelsToken = token;
		jako = token.substring(0, 47) + token.substring(48);
	}

	function refreshToken(reason, done) {
		lastTokenRefreshAt = Date.now();
		fetchJson('/token.php', 5000, function (json) {
			if (json && typeof json.token === "string" && json.token.length > 100) {
				applyToken(json.token);
				if (json.expiresAt) tokenExpiresAt = json.expiresAt * 1000;
				if (json.ipTag) tokenIpTag = json.ipTag;
				track('token_refreshed', { reason: reason });
				done(true);
			} else {
				done(false);
			}
		}, function (why) {
			track('token_refresh_failed', { reason: reason, why: String(why).slice(0, 40) });
			done(false);
		});
	}

	function tokenLooksStale() {
		if (!tokenExpiresAt || Date.now() - lastTokenRefreshAt < 600000) return false;
		return Date.now() >= tokenExpiresAt;
	}

	function describeFailure(reason) {
		var r = String(reason || "");
		if (r === "stall" || r === "no-data") return "no video data arrived for " + STALL_SECONDS + " seconds";
		if (r.indexOf("manifest") !== -1 || r.indexOf("levelLoad") !== -1) return "the stream playlist could not be loaded";
		if (r.indexOf("fragLoad") !== -1) return "video segments could not be loaded";
		if (r.indexOf("mediaError") === 0) return "the video could not be decoded";
		if (r === "media-element-error") return "the player reported an error";
		if (r.indexOf("network-change") === 0) return "the network changed";
		if (r === "player-load-failed") return "the player could not be downloaded";
		return r || "unknown";
	}

	var CHANNELS_INTRO = "Free live cricket streaming for your phone: internationals, IPL, PSL and T20 leagues. Tap a match to watch.";

	function isList(v) {
		return Object.prototype.toString.call(v) === "[object Array]";
	}

	function channelsTitle(box) {
		var intro = document.createElement("div");
		intro.setAttribute("class", "channels-title");
		intro.textContent = "Live and upcoming matches";
		box.appendChild(intro);
	}

	function showChannels(token, expiresAt, ipTag) {
		applyToken(token);
		if (expiresAt) tokenExpiresAt = expiresAt * 1000;
		if (ipTag) tokenIpTag = ipTag;
		var box = document.getElementById("channels");
		if (window.SC_CHANNELS && isList(SC_CHANNELS.channelsList)) {
			data = SC_CHANNELS;
			renderChannels();
		} else { clear(box); channelsTitle(box); channelsLoading(); }
		fetchJson('https://rest.smartcric.stream/mobile/channels/live/' + sn, 8000, function (json) {
			if (!json || !isList(json.channelsList)) { if (!data) renderChannelsError("bad-data"); return; }
			data = json; track('channel_list_ok', { count: json.channelsList.length }); renderChannels();
		}, function (reason) { track('channel_list_failed', { reason: String(reason).slice(0, 40) }); if (!data) renderChannelsError(reason); });
	}

	function renderChannelsError(reason) {
		var box=document.getElementById('channels'); clear(box);
		var e=document.createElement('div'); e.className='empty';
		e.innerHTML='<strong>Matches unavailable</strong><span>Check your connection and try again.</span>';
		box.appendChild(e);
	}

	function renderChannels() {
		var box=document.getElementById('channels'); clear(box); channelsTitle(box);
		if (!data.channelsList.length) { var e=document.createElement('div'); e.className='empty'; e.innerHTML='<strong>No matches right now</strong><span>Check back later for the next fixture.</span>'; box.appendChild(e); return; }
		var order=[],rest=[];
		for(var k=0;k<data.channelsList.length;k++){var c=data.channelsList[k];if(c.streamsList&&c.streamsList.length)order.push(k);else rest.push(k)}
		order=order.concat(rest);
		for(var n=0;n<order.length;n++){
			var i=order[n],c=data.channelsList[i],live=!!(c.streamsList&&c.streamsList.length),state=live?'live':'upcoming';
			var wrap=document.createElement('div'); wrap.className='mca_box2';
			var link=document.createElement('a'); link.className='match-card '+state; link.dataset.state=state;
			link.href=live?'#quality':'#'; link.setAttribute('data-transition','fade');
			if(live) link.onclick=function(idx){return function(){return openChannel(this,idx)}}(i); else link.onclick=function(idx){return function(){return showOfflineCard(idx)}}(i);
			var top=document.createElement('div');top.className='match-top';
			var league=document.createElement('span');league.className='league';league.textContent='CRICKET';
			var badge=document.createElement('span');badge.className='badge '+state;badge.textContent=live?'LIVE':'UPCOMING';top.appendChild(league);top.appendChild(badge);
			var title=document.createElement('div');title.className='match-title';title.textContent=c.caption||'Cricket Match';
			var sub=document.createElement('div');sub.className='match-sub';sub.textContent=live?(c.channelName||'Live stream available'):(c.channelName||'Coming soon');
			var foot=document.createElement('div');foot.className='match-foot';foot.innerHTML='<span>'+ (live?'NOW':'NEXT') +'</span><span class="watch">'+(live?'Watch →':'View details →')+'</span>';
			link.appendChild(top);link.appendChild(title);link.appendChild(sub);link.appendChild(foot);wrap.appendChild(link);box.appendChild(wrap);
		}
	}

	function showLinks(channel){
		clear(document.getElementById('streams'));
		for(var i=0;i<data.channelsList[channel].streamsList.length;i++){
			var mcaDiv=document.createElement('div');mcaDiv.className='mca_box2';
			var link=document.createElement('a');link.href='#video';link.className='quality-card';
			link.setAttribute('onclick','createVideo('+channel+', '+i+')');
			var caption=String(data.channelsList[channel].streamsList[i].caption).trim();
			var a=document.createElement('span');a.textContent=caption+(caption===rememberedQuality()?' · Last used':'');
			var b=document.createElement('span');b.textContent='→';link.appendChild(a);link.appendChild(b);mcaDiv.appendChild(link);document.getElementById('streams').appendChild(mcaDiv);
		}
	}

	var CONTACT_EMAIL = "smartcric@protonmail.com";

	var SHOW_NOT_LIVE_EMAIL = false;

	function closeOfflineCard() {
		var overlay = document.getElementById("scOverlay");
		if (overlay) overlay.parentNode.removeChild(overlay);
	}

	function reportLine(channel, caption) {
		var line = document.createElement("div");
		line.setAttribute("class", "sc-card-contact");
		line.appendChild(document.createTextNode("Should this be live already? "));
		var link = document.createElement("a");
		link.setAttribute("href", "#");
		link.setAttribute("data-ajax", "false");
		link.textContent = "Report it";
		link.onclick = function (e) {
			if (e && e.preventDefault) e.preventDefault();
			line.textContent = "Thanks, we\u2019ve been told.";
			track('not_live_reported', { channel: caption.slice(0, 60) });
			try {
				var x = new XMLHttpRequest();
				x.open("POST", "/report.php", true);
				x.setRequestHeader("Content-Type", "application/json");
				x.send(JSON.stringify({ channelId: data.channelsList[channel].channelId }));
			} catch (err) {}
			return false;
		};
		line.appendChild(link);
		line.appendChild(document.createTextNode("."));
		return line;
	}

	function showOfflineCard(channel) {
		closeOfflineCard();
		var caption = String(data.channelsList[channel].caption).trim();
		track('upcoming_tapped', { channel: caption.slice(0, 60) });

		var overlay = document.createElement("div");
		overlay.setAttribute("id", "scOverlay");
		overlay.setAttribute("class", "sc-overlay");
		var card = document.createElement("div");
		card.setAttribute("class", "sc-card");
		card.setAttribute("role", "dialog");
		card.setAttribute("aria-modal", "true");
		card.setAttribute("aria-labelledby", "scCardTitle");

		var title = document.createElement("div");
		title.setAttribute("id", "scCardTitle");
		title.setAttribute("class", "sc-card-title");
		title.textContent = caption;
		var text = document.createElement("div");
		text.setAttribute("class", "sc-card-text");
		text.textContent = "This match isn't live yet. Check back closer to the start.";
		var contact = document.createElement("div");
		contact.setAttribute("class", "sc-card-contact");
		contact.appendChild(document.createTextNode("Should this be live already? "));
		var mail = document.createElement("a");
		var body = "Hi Smartcric,\n\nThe match \"" + caption + "\" shows as not live on smartcric.is, but it should be on.\n\n"
			+ "Time: " + new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC\n"
			+ "Device: " + navigator.userAgent + "\n\nAnything else you noticed:\n";
		mail.setAttribute("href", "mailto:" + CONTACT_EMAIL
			+ "?subject=" + encodeURIComponent("Stream not live: " + caption)
			+ "&body=" + encodeURIComponent(body));
		mail.setAttribute("data-ajax", "false");
		mail.textContent = "Let us know";
		contact.appendChild(mail);
		contact.appendChild(document.createTextNode("."));
		var btn = document.createElement("button");
		btn.setAttribute("type", "button");
		btn.setAttribute("class", "sc-card-btn");
		btn.setAttribute("data-role", "none");
		btn.textContent = "Back to matches";
		btn.onclick = closeOfflineCard;

		card.appendChild(title);
		card.appendChild(text);
		if (SHOW_NOT_LIVE_EMAIL) card.appendChild(contact);
		else if (window.SC_CONFIG && SC_CONFIG.reportsEnabled) card.appendChild(reportLine(channel, caption));
		card.appendChild(btn);
		overlay.appendChild(card);
		overlay.onclick = function (e) { if (e.target === overlay) closeOfflineCard(); };
		document.body.appendChild(overlay);
		btn.focus();
		return false;
	}

	function rememberedQuality() {
		try { return window.localStorage ? (localStorage.getItem(QUALITY_KEY) || "") : ""; } catch (e) { return ""; }
	}

	function rememberQuality(caption) {
		try { if (window.localStorage) localStorage.setItem(QUALITY_KEY, String(caption).trim()); } catch (e) {}
	}

	function preferredStream(channel) {
		var streams = data.channelsList[channel].streamsList || [];
		if (streams.length === 1) return 0;
		var want = rememberedQuality();
		if (want) {
			for (var j = 0; j < streams.length; j++) {
				if (String(streams[j].caption).trim() === want) return j;
			}
		}
		return -1;
	}

	function openChannel(link, channel) {
		var pick = preferredStream(channel);
		if (pick >= 0) {
			link.setAttribute("href", "#video");
			createVideo(channel, pick);
		} else {
			link.setAttribute("href", "#quality");
			showLinks(channel);
		}
		return true;
	}

	function showLinks (channel){
		clear(document.getElementById("streams"));

		var title = document.createElement ("h1");
		title.textContent="Please select video quality";
		document.getElementById('streams').appendChild(title);

		for (var i=0; i < data.channelsList[channel].streamsList.length; i++){
			var mcaDiv = document.createElement ("div");
			mcaDiv.setAttribute("class","mca_box2");

			var link = document.createElement ("a");

			link.setAttribute ("href", "#video");
			link.setAttribute ("class","ui-btn2 ui-shadow ui-corner-all");
			link.setAttribute ("onclick", "createVideo("+channel+", "+i+")");
			var caption = String(data.channelsList[channel].streamsList[i].caption).trim();
			link.textContent = caption === rememberedQuality() ? caption + " (last used)" : caption;
			link.setAttribute ("data-transition","slide");
			var clearDiv = document.createElement("div");
			clearDiv.setAttribute("class", "clear");
			mcaDiv.appendChild(link);
			mcaDiv.appendChild(clearDiv);
			document.getElementById('streams').appendChild(mcaDiv);
		}
	}

	function createVideo(channel, i) {
		window.currentChannel = channel;
		window.currentStream = i;
		window.currentFmsUrl = data.channelsList[channel].fmsUrl;
		var streams = data.channelsList[channel].streamsList;
		if (streams.length > 1) rememberQuality(streams[i].caption);

		startPlayback(false);
	}

	function destroyPlayer() {
		stopStallWatchdog();
		if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
		if (hls) {
			try { hls.destroy(); } catch (e) {}
			hls = null;
		}
		if (videoPlayer) {
			try {
				videoPlayer.pause();
				videoPlayer.removeAttribute("src");
				videoPlayer.load();
			} catch (e) {}
			videoPlayer = null;
		}
		clear(document.getElementById("videoDiv"));
	}

	function showPlayerMessage(text, detail, spinning, note) {
		var box = document.getElementById("videoDiv");
		var panel = document.createElement("div");
		panel.setAttribute("class", "sc-player-msg");
		panel.setAttribute("role", "status");
		if (spinning) {
			var spin = document.createElement("div");
			spin.setAttribute("class", "sc-spinner");
			panel.appendChild(spin);
		}
		var main = document.createElement("div");
		main.setAttribute("class", "sc-player-msg-text");
		main.textContent = text;
		panel.appendChild(main);
		if (detail) {
			var sub = document.createElement("div");
			sub.setAttribute("class", "sc-player-msg-detail");
			sub.textContent = detail;
			panel.appendChild(sub);
		}
		if (note) {
			var small = document.createElement("div");
			small.setAttribute("class", "sc-player-msg-note");
			small.textContent = note;
			panel.appendChild(small);
		}
		box.appendChild(panel);
	}

	function showPlaybackError() {
		track('playback_failed', currentStreamInfo());
		destroyPlayer();
		var box = document.getElementById("videoDiv");
		showPlayerMessage("The stream stopped.", "Tap Retry to try again, or Reload for a fresh start.", false,
			"Last problem: " + describeFailure(lastFailure));

		var retryBox = document.createElement("div");
		retryBox.setAttribute("class", "mca_box2");
		var retry = document.createElement("a");
		retry.setAttribute("href", "#");
		retry.setAttribute("class", "ui-btn2 ui-shadow ui-corner-all");
		retry.textContent = "Retry";
		retry.onclick = function (e) {
			if (e && e.preventDefault) e.preventDefault();
			refreshChannel(window.currentFmsUrl, function () {
				refreshToken('retry', function () { startPlayback(false); });
			});
			return false;
		};
		retryBox.appendChild(retry);
		box.appendChild(retryBox);

		var reloadBox = document.createElement("div");
		reloadBox.setAttribute("class", "mca_box2");
		var again = document.createElement("a");
		again.setAttribute("href", "#");
		again.setAttribute("class", "ui-btn2 ui-shadow ui-corner-all");
		again.textContent = "Reload";
		again.onclick = function (e) {
			if (e && e.preventDefault) e.preventDefault();
			reload();
			return false;
		};
		reloadBox.appendChild(again);
		box.appendChild(reloadBox);
	}

	function scheduleRestart(reason) {
		if (restartAttempts >= MAX_RESTARTS) {
			showPlaybackError();
			return;
		}
		restartAttempts++;
		lastRestartAt = Date.now();
		lastFailure = reason;
		var info = currentStreamInfo(); info.reason = String(reason).slice(0, 60); info.attempt = restartAttempts;
		track('playback_restart', info);
		var delay = Math.min(2000 * restartAttempts, 8000);
		var failedHost = window.currentFmsUrl;
		destroyPlayer();
		showPlayerMessage("Reconnecting\u2026", "Attempt " + restartAttempts + " of " + MAX_RESTARTS, true);
		restartTimer = setTimeout(function () {
			restartTimer = null;

			refreshChannel(failedHost, function () {
				refreshToken('restart', function () { startPlayback(true); });
			});
		}, delay);
	}

	function refreshChannel(avoidHost, done) {
		var current = data && data.channelsList[window.currentChannel];
		if (!current) { done(); return; }
		var requests = 0;
		var ask = function () {
			requests++;
			fetchJson('https://rest.smartcric.stream/mobile/channels/live/' + sn, 8000, function (json) {
				var list = json && json.channelsList, found = null;
				if (isList(list)) {
					for (var k = 0; k < list.length; k++) {
						var ch = list[k];
						if (ch && ch.channelId === current.channelId && ch.streamsList && ch.streamsList.length) { found = ch; break; }
					}
				}
				if (found && found.fmsUrl === avoidHost && requests < 3) { ask(); return; }
				if (found) {
					if (found.fmsUrl !== window.currentFmsUrl) {
						track('edge_switch', { from: String(window.currentFmsUrl).slice(0, 40), to: String(found.fmsUrl).slice(0, 40), reason: String(lastFailure).slice(0, 60) });
					}
					data.channelsList[window.currentChannel] = found;
					window.currentFmsUrl = found.fmsUrl;
					if (window.currentStream >= found.streamsList.length) window.currentStream = 0;
				}
				done();
			}, function () { done(); });
		};
		ask();
	}

	function playerActive() {
		return !!(hls || videoPlayer);
	}

	function onNetworkChange(source) {
		if (!playerActive()) return;
		destroyPlayer();
		restartAttempts = 0;
		scheduleRestart("network-change:" + source);
	}

	function onNetworkMaybeChanged() {
		if (playerActive()) checkAddress();
	}

	if (navigator.connection && navigator.connection.addEventListener) {
		var lastConnectionType = navigator.connection.type;
		navigator.connection.addEventListener("change", function () {
			var type = navigator.connection.type;
			if (type !== lastConnectionType) {
				lastConnectionType = type;
				onNetworkMaybeChanged();
			}
		});
	}
	window.addEventListener("online", onNetworkMaybeChanged);

	function checkAddress() {
		fetchJson('/token.php', 5000, function (json) {
			if (!json || typeof json.token !== "string" || json.token.length < 100) return;
			var changed = !!(json.ipTag && tokenIpTag && json.ipTag !== tokenIpTag);
			applyToken(json.token);
			if (json.expiresAt) tokenExpiresAt = json.expiresAt * 1000;
			if (json.ipTag) tokenIpTag = json.ipTag;
			if (changed) onNetworkChange("address");
		}, function () {});
	}

	function stopStallWatchdog() {
		if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
	}

	function startStallWatchdog() {
		stopStallWatchdog();
		stallLastTime = -1;
		stallLastProgressAt = Date.now();
		stallTimer = setInterval(function () {
			if (!videoPlayer) { stallLastProgressAt = Date.now(); return; }
			if (videoPlayer.readyState === 0 && videoPlayer.networkState === videoPlayer.NETWORK_LOADING
				&& Date.now() - playStartedAt > STALL_SECONDS * 1000) {
				scheduleRestart("no-data");
				return;
			}
			if (videoPlayer.paused || videoPlayer.ended) {
				stallLastProgressAt = Date.now();
				return;
			}
			if (videoPlayer.currentTime !== stallLastTime) {
				stallLastTime = videoPlayer.currentTime;
				stallLastProgressAt = Date.now();

				if (restartAttempts > 0 && Date.now() - lastRestartAt > 15000) restartAttempts = 0;
				return;
			}
			if (Date.now() - stallLastProgressAt > STALL_SECONDS * 1000) {
				scheduleRestart("stall");
			}
		}, 2000);
	}

	function startMainVideoPlayback(isRestart) {
		var channel = window.currentChannel;
		var i = window.currentStream;
		var host = window.currentFmsUrl;
		if (!isRestart) restartAttempts = 0;

		var page = document.getElementById("video");
		if (isRestart && page && page.className.indexOf("ui-page-active") === -1) return;

		destroyPlayer();

		var stream = data.channelsList[channel].streamsList[i];
		var url = "https://" + host + "/mobile/"+stream.streamName+"/playlist.m3u8?id="+stream.streamId+"&pk=" + jako;
		var box = document.getElementById("videoDiv");
		playStartedAt = Date.now();
		if (!isRestart) track('stream_selected', currentStreamInfo());

		videoPlayer = document.createElement("video");
		videoPlayer.setAttribute("id", "videoplayer");
		videoPlayer.setAttribute("width", "100%");
		videoPlayer.setAttribute("height", "auto");
		videoPlayer.setAttribute("controls", true);
		videoPlayer.setAttribute("autoplay", true);
		videoPlayer.setAttribute("playsinline", "");
		videoPlayer.setAttribute("webkit-playsinline", "");
		videoPlayer.muted = false;

		if (window.Hls && Hls.isSupported()) {

			var cfg = {liveSyncDurationCount: 8, maxBufferLength: 80, manifestLoadingTimeOut: 8000, manifestLoadingMaxRetry: 0};

			if (typeof vidictLoader !== "undefined" && vidictLoader) cfg.fLoader = vidictLoader;
			else track('peer_loader_missing', {});
			hls = new Hls(cfg);
			hls.on(Hls.Events.ERROR, function (event, d) {
				if (!d || !d.fatal) return;

				if (d.type === Hls.ErrorTypes.MEDIA_ERROR && Date.now() - lastMediaRecoverAt > 8000) {
					lastMediaRecoverAt = Date.now();
					track('media_recover', { details: String(d.details).slice(0, 40) });
					try { hls.recoverMediaError(); return; } catch (e) {}
				}
				scheduleRestart(d.type + ":" + d.details);
			});
			hls.attachMedia(videoPlayer);
			hls.on(Hls.Events.MEDIA_ATTACHED, function () {
				hls.loadSource(url);
			});
		} else {

			videoPlayer.src = url;
			var em = document.createElement("em");
			em.textContent = "Sorry, your browser doesn't support HTML5 video.";
			videoPlayer.appendChild(em);
		}

		var thisPlayer = videoPlayer;
		videoPlayer.addEventListener("error", function () {
			if (thisPlayer === videoPlayer) scheduleRestart("media-element-error");
		});

		videoPlayer.addEventListener("playing", function onPlaying() {
			thisPlayer.removeEventListener("playing", onPlaying);
			var info = currentStreamInfo(); info.ms_to_play = Date.now() - playStartedAt; info.attempt = restartAttempts;
			track('playback_started', info);
		});
		box.appendChild(videoPlayer);
		if (data.channelsList[channel].streamsList.length > 1) {
			var q = document.createElement("p");
			q.setAttribute("class", "sc-quality");
			q.appendChild(document.createTextNode("Quality: " + String(stream.caption).trim() + " \u00b7 "));
			var change = document.createElement("a");
			change.setAttribute("href", "#quality");
			change.setAttribute("onclick", "showLinks(" + channel + ")");
			change.textContent = "Change";
			q.appendChild(change);
			box.appendChild(q);
		}
		var playPromise = videoPlayer.play();
		if (playPromise && playPromise.catch) playPromise.catch(function () {});
		startStallWatchdog();

		videoPlayer.addEventListener('touchend', function onTap() {
			playStartedAt = Date.now();
			if (videoPlayer && videoPlayer.paused) videoPlayer.play().catch(function(){});
			if (videoPlayer) videoPlayer.muted = false;
			thisPlayer.removeEventListener('touchend', onTap);
		}, { once:true });
	}

	document.addEventListener("visibilitychange", function () {
		if (document.hidden) return;
		if (playerActive()) checkAddress();
		else if (tokenLooksStale()) refreshToken('date', function () {});
	});
