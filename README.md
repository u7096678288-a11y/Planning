# Radharc Pleanála

A live browser-based mapping dashboard for Irish planning and development intelligence.

## Live data sources

- Irish Planning Applications — ArcGIS REST points and site boundaries
- An Coimisiún Pleanála cases from 2016 onwards
- National freehold cadastral parcels, displayed at local map scales
- CSO Housing Hub linked as the statistical evidence source

The application queries the public ArcGIS FeatureServer endpoints directly. It does not contain the sample application records used by the earlier prototype.

## Features

- Interactive national map
- Planning application, ACP and freehold parcel layers
- Search by planning reference, ACP case, address or description
- Date filters
- Visible-area counts and residential-unit totals
- Decision, authority and ACP-category charts
- Clickable record details and copyable briefs
- Responsive desktop and mobile layout

## Run locally

```bash
python3 -m http.server 8000
```

Open `http://localhost:8000`.

## Publish with GitHub Pages

In the repository, open **Settings → Pages**, select **Deploy from a branch**, choose `main` and `/ (root)`, then save.

Because the repository is currently private, GitHub may require a paid plan for Pages. To keep hosting free, change the repository visibility to public before enabling Pages.

## Previous version

The original prototype has been preserved on the branch `backup-prototype-2026-08-03`.
