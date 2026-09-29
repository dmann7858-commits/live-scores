import React, { useEffect, useRef, useState } from "react";
import {
  View, Text, Linking, StyleSheet, SafeAreaView, Platform,
} from "react-native";
import { WebView } from "react-native-webview";
import { StatusBar } from "expo-status-bar";
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
// The adverts now sit inside the page, between the matches, and are
// controlled from scores.js. The fixed strip at the bottom of the
// screen is switched off. Set SHOW_BOTTOM_BANNER to true to bring it
// back.
// ---------------------------------------------------------------
const SHOW_BOTTOM_BANNER = false;
const USE_TEST_ADS = true;
const BANNER_UNIT_ID = "";   // ca-app-pub-9305446787515470/xxxxxxxxxx

const BANNER_ID = USE_TEST_ADS || !BANNER_UNIT_ID
  ? TestIds.ADAPTIVE_BANNER
  : BANNER_UNIT_ID;

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
  const [adsReady, setAdsReady] = useState(false);
  const [personalised, setPersonalised] = useState(false);
  const [bannerFailed, setBannerFailed] = useState(false);

  useEffect(function () {
    let cancelled = false;
    prepareAds().then(function (allowed) {
      if (cancelled) return;
      setPersonalised(allowed);
      setAdsReady(true);
    });
    return function () { cancelled = true; };
  }, []);

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

      <WebView
        ref={web}
        source={{ uri: APP_URL }}
        style={styles.page}
        originWhitelist={["*"]}
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
        startInLoadingState={true}
        renderError={offlineScreen}
      />

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
