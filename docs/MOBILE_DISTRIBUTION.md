# SISMO911 Mobile Distribution

Public page: `https://sismo911.com/app`

## Android Direct Download

1. Build an internal APK:

```bash
cd mobile
eas build --platform android --profile preview
```

2. Download the APK from EAS.
3. Save it in the web assets as:

```text
public/downloads/sismo911-latest.apk
```

4. Deploy the Worker. The button on `/app` points to that file.

## iPhone

Apple does not allow public direct IPA downloads from a website. Use TestFlight for testers or App Store for public release.

```bash
cd mobile
eas build --platform ios --profile production
```

After the build appears in App Store Connect, create a TestFlight public link and replace the TestFlight URL in `public/app.html`.

## Web App Fallback

The page also links to the existing web/PWA version so users can use SISMO911 immediately without an app-store install.
