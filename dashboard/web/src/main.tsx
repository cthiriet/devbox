import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter, Route, Routes } from "react-router"

import "./index.css"
import { RequireSession, SessionProvider } from "@/components/session"
import { ThemeProvider } from "@/components/theme-provider"
import { Fleet } from "@/screens/fleet"
import { JobScreen } from "@/screens/job"
import { Login } from "@/screens/login"
import { Machine } from "@/screens/machine"
import { NewProfile } from "@/screens/new-profile"
import { NewShape } from "@/screens/new-shape"
import { Orphans } from "@/screens/orphans"
import { ProfileForm } from "@/screens/profile-form"
import { Profiles } from "@/screens/profiles"
import { Jobs } from "@/screens/jobs"
import { SecretsScreen } from "@/screens/secrets"
import { AccountScreen } from "@/screens/account"
import { stashShared } from "@/lib/share"

/**
 * The router, browser side.
 *
 * The server renders the same index.html for `/`, `/login`, `/account`,
 * `/machine/*`, `/job/*`, `/jobs`, `/orphans`, `/new/*`, `/profiles/*` and `/secrets`, with a
 * 200 whatever the session - and each of them is also a line of `routes` in deploy.json, or
 * Caddy never hands it to Bun, and a line of the example Caddyfile in docs/deploy.md, which
 * keeps the same list by hand. An address added here and to none of those is a blank page
 * after a reload; one added to the manifest and not to server.ts is a 404 on a declared
 * route, which fails the deployment for every site. That is a constraint of the
 * deployment as much as a choice: the hosting platform checks every address after a reload
 * and accepts nothing but 200 or 401, a redirect counting as "this address no longer
 * answers" and rolling the whole Caddy configuration back, for every site at once. So it is
 * here, and nowhere else, that showing the login screen is decided.
 *
 * Dark theme by default: this dashboard is opened at night, on a train, and a white
 * background is a flashlight there. The provider allows switching to light for whoever
 * opens it in broad daylight, and the choice is remembered.
 */
// Before the router exists: a shared profile rides in the fragment, and it must be off the
// address before RequireSession copies the address into `from` on the way to /login. See
// lib/share.ts.
stashShared()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider defaultTheme="dark">
      <BrowserRouter>
        <SessionProvider>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route
              path="/account"
              element={
                <RequireSession>
                  <AccountScreen />
                </RequireSession>
              }
            />
            <Route
              path="/"
              element={
                <RequireSession>
                  <Fleet />
                </RequireSession>
              }
            />
            <Route
              path="/new"
              element={
                <RequireSession>
                  <NewProfile />
                </RequireSession>
              }
            />
            <Route
              path="/new/shape"
              element={
                <RequireSession>
                  <NewShape />
                </RequireSession>
              }
            />
            <Route
              path="/machine/:name"
              element={
                <RequireSession>
                  <Machine />
                </RequireSession>
              }
            />
            <Route
              path="/job/:id"
              element={
                <RequireSession>
                  <JobScreen />
                </RequireSession>
              }
            />
            <Route
              path="/jobs"
              element={
                <RequireSession>
                  <Jobs />
                </RequireSession>
              }
            />
            <Route
              path="/orphans"
              element={
                <RequireSession>
                  <Orphans />
                </RequireSession>
              }
            />
            {/* `/profiles/new` composes one and `/profiles/edit?name=` opens one again.
                The second is a query rather than `/profiles/:name` on purpose: a composed
                profile may legitimately be called `new`, and a path that could mean either
                would make that one uneditable. */}
            <Route
              path="/profiles"
              element={
                <RequireSession>
                  <Profiles />
                </RequireSession>
              }
            />
            <Route
              path="/profiles/new"
              element={
                <RequireSession>
                  <ProfileForm />
                </RequireSession>
              }
            />
            <Route
              path="/profiles/edit"
              element={
                <RequireSession>
                  <ProfileForm />
                </RequireSession>
              }
            />
            <Route
              path="/secrets"
              element={
                <RequireSession>
                  <SecretsScreen />
                </RequireSession>
              }
            />
            {/* An unknown address falls back to the fleet: it is the answer to
                "where is it?", and a 404 page would teach no one anything here. */}
            <Route
              path="*"
              element={
                <RequireSession>
                  <Fleet />
                </RequireSession>
              }
            />
          </Routes>
        </SessionProvider>
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>
)
