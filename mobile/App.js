import React, { useEffect, useRef, useState } from "react";
import {
  View, Text, Linking, StyleSheet, SafeAreaView, Platform,
} from "react-native";
import { WebView } from "react-native-webview";
import { StatusBar } from "expo-status-bar";
import AsyncStorage from "@react-native-async-storage/async-storage";
import mobileAds, {
  BannerAd, BannerAdSize, TestIds, AdsConsent,
} from "react-native-google-mobile-ads";
import { requestTrackingPermissionsAsync } from "expo-tracking-transparency";

// Where GoalFlash lives. Everything the app shows comes from here.
const APP_URL = "https://www.goalflash.app";

// Addresses that belong to GoalFlash and open inside the app.
const OUR_HOSTS = [
  "goalflash.app",
  "www.goalflash.app",
  "live-scores-1.onrender.com",
];

// ---------------------------------------------------------------
// ADVERTS
//
// The adverts sit inside the page, between the matches, and are
// controlled from scores.js. The fixed strip at the bottom of the
// screen is switched off. Set SHOW_BOTTOM_BANNER to true to bring
// it back.
// ---------------------------------------------------------------
const SHOW_BOTTOM_BANNER = false;
const USE_TEST_ADS = true;
const BANNER_UNIT_ID = "";   // ca-app-pub-9305446787515470/xxxxxxxxxx

const BANNER_ID = USE_TEST_ADS || !BANNER_UNIT_ID
  ? TestIds.ADAPTIVE_BANNER
  : BANNER_UNIT_ID;

// ---------------------------------------------------------------
// THE BACKUP
//
// iOS can throw away the web page's saved data on its own, taking
// XP, clubs, the squad and the anonymous account key with it. So the
// page sends the app a copy of everything it saves, and the app keeps
// that copy in its own storage, which iOS does not clear.
//
// When the app opens, the copy is handed back to the page before
// anything on it runs - but only if the page has lost its own data.
// If the page still has its data, it is left alone. If somebody chose
// "Clear this device" or deleted their account, the page leaves a
// marker and the backup is not restored over their fresh start.
// ---------------------------------------------------------------
const BACKUP_KEY = "goalflash-backup-v1";

function restoreScript(saved) {
  // Turned into a safe JavaScript string, so nothing in the saved
  // data can break out of it.
  const payload = JSON.stringify(saved || "");

  return "(function () {" +
    "try {" +
      "var raw = " + payload + ";" +
      "if (!raw) return;" +
      "var snap = JSON.parse(raw);" +
      "var store = window.localStorage;" +
      "if (store.getItem('authRefresh') || store.getItem('xp') !== null ||" +
      "    store.getItem('gfCleared')) return;" +
      "for (var name in snap) {" +
        "if (Object.prototype.hasOwnProperty.call(snap, name) && snap[name] !== null) {" +
          "store.setItem(name, String(snap[name]));" +
        "}" +
      "}" +
      "store.setItem('gfRestored', String(Date.now()));" +
    "} catch (error) {}" +
  "})();" +
  "true;";
}

function hostOf(url) {
  const match = String(url || "").match(/^https?:\/\/([^\/?#:]+)/i);
  return match ? match[1].toLowerCase() : "";
}

function isOurs(url) {
  return OUR_HOSTS.indexOf(hostOf(url)) !== -1;
}

// Consent first (Google's message, only shown in the UK, EU and
// Switzerland), then Apple's tracking question, then the ads SDK.
async function prepareAds() {
  let personalised = false;

  try {
    await AdsConsent.requestInfoUpdate();
    await AdsConsent.loadAndShowConsentFormIfRequired();
  } catch (error) {
    // No consent message set up in AdMob yet, or offline. Carry on.
  }

  try {
    if (Platform.OS === "ios") {
      const result = await requestTrackingPermissionsAsync();
      personalised = result.status === "granted";
    }
  } catch (error) {
    personalised = false;
  }

  try {
    await mobileAds().initialize();
  } catch (error) {
    // Adverts simply will not load. The app itself carries on.
  }

  return personalised;
}

export default function App() {
  const web = useRef(null);
  const [saved, setSaved] = useState(undefined);   // undefined = still reading
  const [adsReady, setAdsReady] = useState(false);
  const [personalised, setPersonalised] = useState(false);
  const [bannerFailed, setBannerFailed] = useState(false);

  // Read the backup before the page is shown, so it can be handed
  // over before anything on the page runs.
  useEffect(function () {
    let cancelled = false;
    AsyncStorage.getItem(BACKUP_KEY)
      .then(function (value) { if (!cancelled) setSaved(value || ""); })
      .catch(function () { if (!cancelled) setSaved(""); });
    return function () { cancelled = true; };
  }, []);

  useEffect(function () {
    let cancelled = false;
    prepareAds().then(function (allowed) {
      if (cancelled) return;
      setPersonalised(allowed);
      setAdsReady(true);
    });
    return function () { cancelled = true; };
  }, []);

  // Messages from the page: a fresh copy to keep, or a deliberate
  // wipe to follow.
  function handleMessage(event) {
    let message;
    try {
      message = JSON.parse(event.nativeEvent.data);
    } catch (error) {
      return;
    }
    if (!message) return;

    if (message.type === "gfBackup" && message.data) {
      AsyncStorage.setItem(BACKUP_KEY, JSON.stringify(message.data))
        .catch(function () {});
    } else if (message.type === "gfClear") {
      AsyncStorage.removeItem(BACKUP_KEY).catch(function () {});
    }
  }

  // Decides where each page load goes.
  function handleLink(request) {
    const url = request.url || "";

    if (url.startsWith("about:") || url.startsWith("data:") ||
        url.startsWith("blob:")) {
      return true;
    }

    // Frames inside the page - adverts included - load where they are.
    if (request.isTopFrame === false) return true;

    // GoalFlash's own pages stay in the app.
    if (isOurs(url)) return true;

    // Anything else opens in Safari, so the person can come back.
    Linking.openURL(url);
    return false;
  }

  // News headlines and tapped adverts ask for a new window. Those
  // open in Safari.
  function handleNewWindow(event) {
    const url = event.nativeEvent && event.nativeEvent.targetUrl;
    if (url) Linking.openURL(url);
  }

  function offlineScreen() {
    return (
      <View style={styles.offline}>
        <Text style={styles.offlineHead}>GoalFlash can't connect</Text>
        <Text style={styles.offlineText}>
          Check your internet connection, then pull down to try again.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.page}>
      <StatusBar style="light" />

      {saved === undefined ? (
        // A split second while the backup is read.
        <View style={styles.page} />
      ) : (
        <WebView
          ref={web}
          source={{ uri: APP_URL }}
          style={styles.page}
          originWhitelist={["*"]}
          injectedJavaScriptBeforeContentLoaded={restoreScript(saved)}
          onMessage={handleMessage}
          onShouldStartLoadWithRequest={handleLink}
          onOpenWindow={handleNewWindow}
          setSupportMultipleWindows={true}
          applicationNameForUserAgent="GoalFlashApp/1.0"
          allowsBackForwardNavigationGestures={true}
          pullToRefreshEnabled={true}
          contentInsetAdjustmentBehavior="never"
          domStorageEnabled={true}
          javaScriptEnabled={true}
          sharedCookiesEnabled={true}
          cacheEnabled={true}
          startInLoadingState={true}
          renderError={offlineScreen}
          // iOS sometimes shuts the page down in the background to
          // save memory, which leaves a blank white screen. Reload it.
          onContentProcessDidTerminate={function () {
            if (web.current) web.current.reload();
          }}
        />
      )}

      {SHOW_BOTTOM_BANNER && adsReady && !bannerFailed ? (
        <SafeAreaView style={styles.bannerArea}>
          <View style={styles.bannerInner}>
            <BannerAd
              unitId={BANNER_ID}
              size={BannerAdSize.ANCHORED_ADAPTIVE_BANNER}
              requestOptions={{
                requestNonPersonalizedAdsOnly: !personalised,
              }}
              onAdFailedToLoad={function () { setBannerFailed(true); }}
            />
          </View>
        </SafeAreaView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#0B1E3D" },
  bannerArea: { backgroundColor: "#0B1E3D" },
  bannerInner: { alignItems: "center", paddingTop: 4 },
  offline: {
    flex: 1, backgroundColor: "#0B1E3D",
    alignItems: "center", justifyContent: "center", padding: 30,
  },
  offlineHead: { color: "#FFFFFF", fontSize: 18, fontWeight: "600", marginBottom: 10 },
  offlineText: { color: "#8FA6C4", fontSize: 14, textAlign: "center" },
});
