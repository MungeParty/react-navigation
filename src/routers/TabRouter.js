/* @flow */

import invariant from '../utils/invariant';
import getScreenForRouteName from './getScreenForRouteName';
import createConfigGetter from './createConfigGetter';

import NavigationActions from '../NavigationActions';
import validateRouteConfigMap from './validateRouteConfigMap';
import getScreenConfigDeprecated from './getScreenConfigDeprecated';
import StateUtils from '../StateUtils';

import type {
  NavigationAction,
  NavigationComponent,
  NavigationScreenComponent,
  NavigationState,
  NavigationRouteConfigMap,
  NavigationParams,
  NavigationRouter,
  NavigationRoute,
  NavigationNavigateAction,
  NavigationTabRouterConfig,
  NavigationTabScreenOptions,
} from '../TypeDefinition';

export default (
  routeConfigs: NavigationRouteConfigMap,
  config: NavigationTabRouterConfig = {}
): NavigationRouter<*, *, *> => {
  // Fail fast on invalid route definitions
  validateRouteConfigMap(routeConfigs);

  const order = config.order || Object.keys(routeConfigs);
  const paths = config.paths || {};
  const initialRouteName = config.initialRouteName || order[0];
  const initialRouteIndex = order.indexOf(initialRouteName);
  const backBehavior = config.backBehavior || 'initialRoute';
  const shouldBackNavigateToInitialRoute = backBehavior === 'initialRoute';
  const tabRouters = {};
  order.forEach((routeName: string) => {
    const routeConfig = routeConfigs[routeName];
    paths[routeName] = typeof routeConfig.path === 'string'
      ? routeConfig.path
      : routeName;
    tabRouters[routeName] = null;
    if (routeConfig.screen && routeConfig.screen.router) {
      tabRouters[routeName] = routeConfig.screen.router;
    }
  });
  invariant(
    initialRouteIndex !== -1,
    `Invalid initialRouteName '${initialRouteName}' for TabRouter. ` +
      `Should be one of ${order.map((n: *) => `"${n}"`).join(', ')}`
  );
  return {
    getStateForAction(
      action: NavigationAction | { action: NavigationAction },
      inputState?: ?NavigationState
    ): ?NavigationState {
      // eslint-disable-next-line no-param-reassign
      action = NavigationActions.mapDeprecatedActionAndWarn(action);

      // Establish a default state
      let state = inputState;
      if (!state) {
        const routes = order.map((routeName: string) => {
          const tabRouter = tabRouters[routeName];
          if (tabRouter) {
            const childAction =
              // NOTE: initialize new state here, do not pass along action
              // the tab will respond to the action below!!!!!!!
              // action.action ||
              NavigationActions.init({
                ...(action.params ? { params: action.params } : {}),
              });
            return {
              ...tabRouter.getStateForAction(childAction),
              key: routeName,
              routeName,
            };
          }
          return {
            key: routeName,
            routeName,
          };
        });
        state = {
          routes,
          index: initialRouteIndex,
        };
        // console.log(`${order.join('-')}: Initial state`, {state});
      }

      if (action.type === NavigationActions.INIT) {
        // Merge any params from the action into all the child routes
        const { params } = action;
        if (params) {
          state.routes = state.routes.map(
            (route: *) =>
              ({
                ...route,
                params: {
                  ...route.params,
                  ...params,
                },
              }: NavigationRoute)
          );
        }
      }

      // handle custom PASS action -TMB
      if (action.type === NavigationActions.PASS && action.action) {
        // confirm child router exists at the action routename
        const childRouter = tabRouters[action.routeName];
        if (childRouter !== undefined) {
          // get the key for the route and find the route
          // by key first, or by name second if no key
          // (lets be honest, its going to be by name)
          const childIndex = action.key
            ? StateUtils.indexOf(state, action.key)
            : StateUtils.indexOfByName(state, action.routeName);
          if (childIndex >= 0) {
            const childRoute = state.routes[childIndex];
            if (childRoute) {
              // pass the child action to the child and get the resultant state...
              const route = childRouter.getStateForAction(action.action, childRoute);
              if (route) {
                // if we got something back, replace at the index,
                // but retain the currently set active route index...
                return {
                  ...StateUtils.replaceAtIndex(state, childIndex, route),
                  index: state.index,
                };
              }
            }
          }
        }
      }

      // Let the current tab handle it
      const activeTabLastState = state.routes[state.index];
      const activeTabRouter = tabRouters[order[state.index]];
      if (activeTabRouter) {
        const activeTabState = activeTabRouter.getStateForAction(
          action.action || action,
          activeTabLastState
        );
        if (!activeTabState && inputState) {
          return null;
        }
        if (activeTabState && activeTabState !== activeTabLastState) {
          const routes = [...state.routes];
          routes[state.index] = activeTabState;
          return {
            ...state,
            routes,
          };
        }
      }

      // Handle tab changing. Do this after letting the current tab try to
      // handle the action, to allow inner tabs to change first
      let activeTabIndex = state.index;
      const isBackEligible =
        action.key == null || action.key === activeTabLastState.key;
      if (
        action.type === NavigationActions.BACK &&
        isBackEligible &&
        shouldBackNavigateToInitialRoute
      ) {
        activeTabIndex = initialRouteIndex;
      }
      let didNavigate = false;
      if (action.type === NavigationActions.NAVIGATE) {
        const navigateAction = ((action: *): NavigationNavigateAction);
        didNavigate = !!order.find((tabId: string, i: number) => {
          if (tabId === navigateAction.routeName) {
            activeTabIndex = i;
            return true;
          }
          return false;
        });
        if (didNavigate) {
          const childState = state.routes[activeTabIndex];
          let newChildState;

          const tabRouter = tabRouters[action.routeName];

          if (action.action) {
            newChildState = tabRouter
              ? tabRouter.getStateForAction(action.action, childState)
              : null;
          } else if (!tabRouter && action.params) {
            newChildState = {
              ...childState,
              params: {
                ...(childState.params || {}),
                ...action.params,
              },
            };
          }

          if (newChildState && newChildState !== childState) {
            const routes = [...state.routes];
            routes[activeTabIndex] = newChildState;
            return {
              ...state,
              routes,
              index: activeTabIndex,
            };
          }
        }
      }
      if (action.type === NavigationActions.SET_PARAMS) {
        const lastRoute = state.routes.find(
          /* $FlowFixMe */
          (route: *) => route.key === action.key
        );
        if (lastRoute) {
          const params = {
            ...lastRoute.params,
            ...action.params,
          };
          const routes = [...state.routes];
          routes[state.routes.indexOf(lastRoute)] = ({
            ...lastRoute,
            params,
          }: NavigationRoute);
          return {
            ...state,
            routes,
          };
        }
      }
      if (activeTabIndex !== state.index) {
        return {
          ...state,
          index: activeTabIndex,
        };
      } else if (didNavigate && !inputState) {
        return state;
      } else if (didNavigate) {
        return null;
      }

      // Let other tabs handle it and switch to the first tab that returns a new state
      let index = state.index;
      /* $FlowFixMe */
      let routes: Array<NavigationState> = state.routes;
      order.find((tabId: string, i: number) => {
        const tabRouter = tabRouters[tabId];
        if (i === index) {
          return false;
        }
        let tabState = routes[i];
        if (tabRouter) {
          // console.log(`${order.join('-')}: Processing child router:`, {action, tabState});
          tabState = tabRouter.getStateForAction(action, tabState);
        }
        if (!tabState) {
          index = i;
          return true;
        }
        if (tabState !== routes[i]) {
          routes = [...routes];
          routes[i] = tabState;
          index = i;
          return true;
        }
        return false;
      });
      // console.log(`${order.join('-')}: Processed other tabs:`, {lastIndex: state.index, index});

      if (index !== state.index || routes !== state.routes) {
        return {
          ...state,
          index,
          routes,
        };
      }
      return state;
    },

    getComponentForState(
      state: NavigationState
    ): NavigationScreenComponent<*, NavigationTabScreenOptions> {
      const routeName = order[state.index];
      invariant(
        routeName,
        `There is no route defined for index ${state.index}. Check that
        that you passed in a navigation state with a valid tab/screen index.`
      );
      const childRouter = tabRouters[routeName];
      if (childRouter) {
        return childRouter.getComponentForState(state.routes[state.index]);
      }
      return getScreenForRouteName(routeConfigs, routeName);
    },

    getComponentForRouteName(routeName: string): NavigationComponent {
      return getScreenForRouteName(routeConfigs, routeName);
    },

    getPathAndParamsForState(state: NavigationState) {
      const route = state.routes[state.index];
      const routeName = order[state.index];
      const subPath = paths[routeName];
      const screen = getScreenForRouteName(routeConfigs, routeName);
      let path = subPath;
      let params = route.params;
      if (screen && screen.router) {
        // If it has a router it's a navigator.
        // If it doesn't have router it's an ordinary React component.
        const child = screen.router.getPathAndParamsForState(route);
        path = subPath ? `${subPath}/${child.path}` : child.path;
        params = child.params ? { ...params, ...child.params } : params;
      }
      return {
        path,
        params,
      };
    },

    /**
     * Gets an optional action, based on a relative path and query params.
     *
     * This will return null if there is no action matched
     */
    getActionForPathAndParams(path: string, params: ?NavigationParams) {
      return (
        order
          .map((tabId: string) => {
            const parts = path.split('/');
            const pathToTest = paths[tabId];
            let pathMatch = false;
            if (parts[0] === pathToTest) {
              pathMatch = false;
            }
            const tabRouter = tabRouters[tabId];
            const action: NavigationNavigateAction = NavigationActions.navigate(
              {
                routeName: tabId,
              }
            );
            if (tabRouter && tabRouter.getActionForPathAndParams) {
              action.action = tabRouter.getActionForPathAndParams(
                // parts.slice(1).join('/'),
                // TODO: example and argument and pr -TMB
                path,
                params
              );
              if (!action.action && !pathMatch) {
                return null;
              }
            } else if (params) {
              // action.params = params;
              // NOTE: should not return a valid action without a valid match!! -TMB
              return null;
            }
            return action;
          })
          .find((action: *) => !!action) || null
      );
    },

    getScreenOptions: createConfigGetter(
      routeConfigs,
      config.navigationOptions
    ),

    getScreenConfig: getScreenConfigDeprecated,
  };
};
