'use strict';

var _ = require('../underscore_ext');
var Rx = require('../rx');
var xenaQuery = require('../xenaQuery');
var kmModel = require('../models/km');
var {userServers, setCohort, fetchSamples,
	fetchColumnData, fetchCohortData,
	updateWizard, clearWizardCohort} = require('./common');
var {setFieldType} = require('../models/fieldSpec');
var {getColSpec} = require('../models/datasetJoins');
var {setNotifications} = require('../notifications');
var fetchSamplesFrom = require('../samplesFrom');
var fetch = require('../fieldFetch');
var {remapFields} = require('../models/searchSamples');
var {fetchInlineState} = require('../inlineState');
var {compose, make, mount} = require('./utils');
var {JSONToqueryString} = require('../dom_helper');
var {parseBookmark} = require('../bookmark');
import parseManifest from '../manifest';

function fetchBookmark(serverBus, bookmark) {
	serverBus.next(['bookmark', Rx.Observable.ajax({
		responseType: 'text',
		method: 'GET',
		url: `/api/bookmarks/bookmark?id=${bookmark}`
	}).map(r => parseBookmark(r.response))]);
}

function fetchManifest(serverBus, url) {
	serverBus.next(['manifest', Rx.Observable.ajax({
		responseType: 'text',
		method: 'GET',
		url
	}).map(r => parseManifest(r.response))]);
}

function exampleQuery(dsID, count) {
	return xenaQuery.datasetFieldExamples(dsID, count)
		.map(list => _.pluck(list, 'name'));
}

function fetchExamples(serverBus, dsID, count = 2) {
	serverBus.next(['columnEdit-examples', exampleQuery(dsID, count)]);
}

var {featureList} = xenaQuery;

function fetchFeatures(serverBus, dsID) {
	return serverBus.next(['columnEdit-features', featureList(dsID)]);
}

var hasSurvFields  = vars => !!(((vars.ev && vars.tte) ||
				(vars.osEv && vars.osTte) ||
				(vars.dfiEv && vars.dfiTte) ||
				(vars.dssEv && vars.dssTte) ||
				(vars.pfiEv && vars.pfiTte)) && vars.patient);

var probeFieldSpec = ({dsID, name}) => ({
	dsID,
	fetchType: 'xena', // maybe take from dataset meta instead of hard-coded
	valueType: 'float',
	fieldType: 'probes',
	fields: [name]
});

var codedFieldSpec = ({dsID, name}) => ({
	dsID,
	fetchType: 'xena', // maybe take from dataset meta instead of hard-coded
	valueType: 'coded',
	fieldType: 'clinical',
	fields: [name]
});

function mapToObj(keys, fn) {
	return _.object(keys, _.map(keys, fn));
}

function survivalFields(cohort, datasets, features) {
	var vars = kmModel.pickSurvivalVars(features),
		fields = {};

	if (hasSurvFields(vars)) {
		fields[`patient`] = getColSpec([codedFieldSpec(vars.patient)], datasets);
		if (vars.osEv && vars.osTte) {
			fields[`osEv`] = getColSpec([probeFieldSpec(vars.osEv)], datasets);
			fields[`osTte`] = getColSpec([probeFieldSpec(vars.osTte)], datasets);
		}
		if (vars.dfiEv && vars.dfiTte) {
			fields[`dfiEv`] = getColSpec([probeFieldSpec(vars.dfiEv)], datasets);
			fields[`dfiTte`] = getColSpec([probeFieldSpec(vars.dfiTte)], datasets);
		}
		if (vars.dssEv && vars.dssTte) {
			fields[`dssEv`] = getColSpec([probeFieldSpec(vars.dssEv)], datasets);
			fields[`dssTte`] = getColSpec([probeFieldSpec(vars.dssTte)], datasets);
		}
		if (vars.pfiEv && vars.pfiTte) {
			fields[`pfiEv`] = getColSpec([probeFieldSpec(vars.pfiEv)], datasets);
			fields[`pfiTte`] = getColSpec([probeFieldSpec(vars.pfiTte)], datasets);
		}
		if (vars.ev && vars.tte &&
			!(vars.osEv && vars.osTte) &&
			!(vars.dfiEv && vars.dfiTte) &&
			!(vars.dssEv && vars.dssTte) &&
			!(vars.pfiEv && vars.pfiTte)) {
				fields[`ev`] = getColSpec([probeFieldSpec(vars.ev)], datasets);
				fields[`tte`] = getColSpec([probeFieldSpec(vars.tte)], datasets);
			}
	}
	return fields;
}

// If field set has changed, re-fetch.
function fetchSurvival(serverBus, state) {
	let {wizard: {datasets, features},
			spreadsheet: {cohort, survival, cohortSamples}} = state,
		fields = survivalFields(cohort, datasets, features),
		survFields = _.keys(fields),
		refetch = _.some(survFields,
				f => !_.isEqual(fields[f], _.getIn(survival, [f, 'field']))),
		queries = _.map(survFields, key => fetch(fields[key], cohortSamples)),
		collate = data => mapToObj(survFields,
				(k, i) => ({field: fields[k], data: data[i]}));

	refetch && serverBus.next([
			'km-survival-data', Rx.Observable.zipArray(...queries).map(collate)]);
}

var warnZoom = state => !_.getIn(state, ['notifications', 'zoomHelp']) ?
	_.assoc(state, 'zoomHelp', true) : state;

var zoomHelpClose = state =>
	_.assocIn(_.dissoc(state, 'zoomHelp'),
			['notifications', 'zoomHelp'], true);

function getChartOffsets(column) {
	return fetchSamplesFrom(column).flatMap(samples => fetch(column, samples)).map(data => {
		var fields = _.getIn(data, ['req', 'probes'], column.fields),
			values = _.getIn(data, ['req', 'values']);
		return _.object(fields, _.map(values, _.meannull));
	});
}

function fetchCohortMeta(serverBus) {
	serverBus.next(['cohortMeta', xenaQuery.fetchCohortMeta]);
}

function fetchCohortPreferred(serverBus) {
	serverBus.next(['cohortPreferred', xenaQuery.fetchCohortPreferred]);
}

function fetchCohortPhenotype(serverBus) {
	serverBus.next(['cohortPhenotype', xenaQuery.fetchCohortPhenotype]);
}

function setLoadingState(state, params) {
	var pending =  (_.get(params, 'bookmark') || _.get(params, 'inlineState')) ?
		_.assoc(state, 'loadPending', true) : state;
	return pending;
}

function fetchState(serverBus) {
	serverBus.next(['inlineState', fetchInlineState()]);
}

function resetWizard(state) {
	return state.columnOrder.length > 2 ?
		_.assoc(state, 'wizardMode', false, 'showWelcome', false) : state;
}

// Fetches the gene strand info for a geneProbes field.
function fetchStrand(serverBus, state, id, gene, dataset) {
	var {probemap, dsID} = dataset,
		{host} = JSON.parse(dsID);
	serverBus.next([['strand', id], xenaQuery.probemapGeneStrand(host, probemap, gene).catch(err => {console.log(err); return Rx.Observable.of('+');})]);
}

// Use min app width (1280px) if viewport width is currently smaller than min
// app width. (App is responsive above 1280px but components are snapped at a
// minimum width of 1280px)
var defaultWidth = viewportWidth => {
	var width = (viewportWidth < 1280 ? 1280 : viewportWidth);
	return Math.floor((width - 48) / 4) - 16; // Allow for 2 x 24px gutter on viewport, plus 16px margin for column
};

// XXX This same info appears in Datapages.js, and in various links.
var getPage = path =>
	path === '/transcripts/' ? 'transcripts' :
	path === '/hub/' ? 'hub' :
	path === '/datapages/' ? 'datapages' :
	'heatmap';

// XXX This same info also appears in urlParams.js
var savedParams = params => _.pick(params, 'dataset', 'hubs', 'host', 'cohort', 'allIdentifiers');
var setPage = (state, path, params) =>
	_.assoc(state,
			'page', getPage(path),
			'params', savedParams(params));

var paramList = params => _.isEmpty(params) ? '' : `?${JSONToqueryString(params)}`;

var controls = {
	init: (state, pathname = '/', params = {}) => {
		var wizardUpate = params.hubs || params.inlineState ?
				clearWizardCohort : _.identity,
			next = setLoadingState(state, params);
		return wizardUpate(setPage(next, pathname, params));
	},
	'init-post!': (serverBus, state, newState, pathname, params) => {
		var bookmark = _.get(params, 'bookmark'),
			inlineState = _.get(params, 'inlineState'),
			manifest = _.get(params, 'manifest');
		if (inlineState) {
			fetchState(serverBus);
		} else if (bookmark) {
			fetchBookmark(serverBus, bookmark);
		} else {
			// 'servers' is in spreadsheet state. After loading a bookmark or inline
			// state, we need to update wizard data. Otherwise, we need to load
			// wizard data here.

			updateWizard(serverBus, state.spreadsheet, newState.spreadsheet, {force: true});
		}
		// These are independent of server settings.
		if (!newState.wizard.cohortMeta) {
			fetchCohortMeta(serverBus);
		}
		if (!newState.wizard.cohortPreferred) {
			fetchCohortPreferred(serverBus);
		}
		if (!newState.wizard.cohortPhenotype) {
			fetchCohortPhenotype(serverBus);
		}
		if (manifest) {
			fetchManifest(serverBus, manifest);
		}
	},
	navigate: (state, page, params = {}) => _.assoc(state, 'page', page, 'params', params),
	'navigate-post!': (serverBus, state, newState, page, params) => history.pushState({}, '', `/${page}/${paramList(params)}`),
	history: (state, history) => _.isEmpty(history) ? state :
		_.Let(({path, params = {}} = history) =>
			_.assoc(state, 'page', getPage(path), 'params', params)),
	cohort: (state, cohort, width) =>
		clearWizardCohort(
			_.updateIn(state, ['spreadsheet'], setCohort({name: cohort}, width))),
	'cohort-post!': (serverBus, state, newState) =>
		fetchCohortData(serverBus, newState.spreadsheet),
	cohortReset: state =>
			clearWizardCohort(
				_.updateIn(state, ['spreadsheet'], setCohort(undefined, undefined))),
	'import': (state, newState) => clearWizardCohort(_.merge(state, newState)),
	'import-error': state => _.assoc(state, 'stateError', 'import'),
	'refresh-cohorts': clearWizardCohort,
	stateError: (state, error) => _.assoc(state, 'stateError', error),
	'km-open-post!': (serverBus, state, newState) => fetchSurvival(serverBus, newState, {}), // 2nd param placeholder for km.user
};

var spreadsheetControls = {
	'import-post!': (serverBus, state, newState) =>
		updateWizard(serverBus, state, newState, {force: true}),
	'refresh-cohorts-post!': (serverBus, state, newState) => {
		fetchCohortMeta(serverBus);
		fetchCohortPreferred(serverBus);
		fetchCohortPhenotype(serverBus);
		updateWizard(serverBus, state, newState, {force: true});
	},
	sampleFilter: (state, sampleFilter) => _.assoc(state,
			'cohort', _.assocIn(state.cohort, ['sampleFilter'], sampleFilter),
			'survival', null),
	'sampleFilter-post!': (serverBus, state, newState) =>
		fetchSamples(serverBus, userServers(newState), newState.cohort, newState.allowOverSamples),
	'add-column': (state, posOrId, ...idSettingsList) => {
		var {columnOrder, columns, sampleSearch, data} = state, // old settings
			isPos = _.isNumber(posOrId),
			pos = isPos ? posOrId : columnOrder.indexOf(posOrId) - 1,
			ids = _.pluck(idSettingsList, 'id'),
			settingsList = _.pluck(idSettingsList, 'settings'),
			newOrder = _.splice(columnOrder, pos + 1, isPos ? 0 : 1, ...ids),
			newState = _.assoc(state,
				'columns', _.merge(columns, _.object(ids, settingsList)),
				'columnOrder', newOrder,
				'sampleSearch', remapFields(columnOrder, newOrder, sampleSearch),
				'editing', null, // is editing always off after column add?
				'data', _.merge(data, _.object(ids, ids.map(_.constant({'status': 'loading'})))));
		return resetWizard(newState);
	},
	'add-column-post!': (serverBus, state, newState, pos, ...idSettingsList) => {
		idSettingsList.forEach(({id, settings}) => {
			// For geneProbes, fetch the gene model (just strand right now), and defer the
			// data fetch.
			if (settings.fieldType === 'geneProbes') {
				// Pick first fieldSpec, and 1st gene name.
				fetchStrand(serverBus, state, id, settings.fieldSpecs[0].fields[0], settings.dataset);
			} else {
				fetchColumnData(serverBus, state.cohortSamples, id, _.getIn(newState, ['columns', id]));
			}
		});
	},
	'edit-column': (state, editing) => _.assoc(state, 'editing', editing),
	resize: (state, id, {width, height}) =>
		_.assocInAll(state,
				['zoom', 'height'], Math.round(height),
				['columns', id, 'width'], Math.round(width)),
	// If 'editing' is a blank column (isNumber), we need to decrement it
	// if it is higher than id index, to preserve its position in the order.
	remove: (state, id) => {
		var {columns, columnOrder, data, editing} = state,
			newEditing = _.isNumber(editing) &&
				editing >= state.columnOrder.indexOf(id) ? editing - 1 : editing,
			ns = _.assoc(state,
				'editing', newEditing,
				'columns', _.dissoc(columns, id),
				'columnOrder', _.without(columnOrder, id),
				'data', _.dissoc(data, id));
		return _.assoc(ns, 'sampleSearch', remapFields(state.columnOrder, ns.columnOrder, state.sampleSearch));
	},
	order: (state, order) => {
		// Filter out 'editing' columns
		var newOrder = order.filter(id => !_.isNumber(id)),
			editing = _.findIndexDefault(order.slice(1), _.isNumber, state.editing);
		return _.assoc(state, 'columnOrder', newOrder,
			'editing', editing,
			'sampleSearch', remapFields(state.columnOrder, order, state.sampleSearch));
	},
	zoom: (state, zoom) => warnZoom(_.assoc(state, "zoom", zoom)),
	'zoom-help-close': zoomHelpClose,
	'zoom-help-disable': zoomHelpClose,
	'zoom-help-disable-post!': (serverBus, state, newState) =>
		setNotifications(newState.notifications),
	'notifications-disable': (state, key) => _.assocIn(state, ['notifications', key], true),
	'notifications-disable-post!': (serverBus, state, newState) => setNotifications(newState.notifications),
	'notifications-enable': state => _.assoc(state, 'notifications', {}),
	'notifications-enable-post!': (serverBus, state, newState) => setNotifications(newState.notifications),
	reload: (state, id) => _.assocIn(state, ['data', id, 'status'], 'loading'),
	'reload-post!': (serverBus, state, newState, id) =>
		fetchColumnData(serverBus, newState.cohortSamples, id, _.getIn(newState, ['columns', id])),
	fieldType: (state, id, fieldType) =>
		_.updateIn(state,
				['columns', id], setFieldType(fieldType),
				['data', id, 'status'], () => 'loading'),
	'fieldType-post!': (serverBus, state, newState, id) =>
		fetchColumnData(serverBus, newState.cohortSamples, id, _.getIn(newState, ['columns', id])),
	vizSettings: (state, column, settings) =>
		_.assocIn(state, ['columns', column, 'vizSettings'], settings),
	'edit-dataset-post!': (serverBus, state, newState, dsID, meta) => {
		if (!_.contains(['mutationVector', 'clinicalMatrix', 'genomicSegment'],
				meta.type)) {
			fetchExamples(serverBus, dsID);
		}
		if (_.contains(['mutationVector', 'genomicSegment'], meta.type)) {
			fetchFeatures(serverBus, dsID);
		}
	},
	'columnLabel': (state, id, value) =>
		_.assocIn(state, ['columns', id, 'user', 'columnLabel'], value),
	'fieldLabel': (state, id, value) =>
		_.assocIn(state, ['columns', id, 'user', 'fieldLabel'], value),
	'showIntrons': (state, id) =>
		_.updateIn(state, ['columns', id, 'showIntrons'], v => !v),
	'sortVisible': (state, id, value) =>
		_.assocIn(state, ['columns', id, 'sortVisible'], value),
	'km-open': (state, id) => _.assocInAll(state,
			['km', 'id'], id,
			['km', 'title'], _.getIn(state, ['columns', id, 'user', 'columnLabel']),
			['km', 'label'], _.getIn(state, ['columns', id, 'user', 'fieldLabel']),
			['km', 'survivalType'], _.intersection([_.getIn(state, ['km', 'survivalType'])], _.keys(_.getIn(state, ['survival']))) [0]),
	// see km-open-post! in controls, above. Requires wizard.datasets.
	'km-close': state => _.assocIn(state, ['km', 'id'], null),
	'km-cutoff': (state, value) => _.assocIn(state, ['km', 'cutoff'], value),
	'km-splits': (state, value) => _.assocIn(state, ['km', 'splits'], value),
	'km-survivalType': (state, value) => _.assocIn(state, ['km', 'survivalType'], value),
	'heatmap': state => _.assoc(state, 'mode', 'heatmap'),
	'chart': state => _.assoc(state, 'mode', 'chart'),
	'chart-set-state': (state, chartState) => _.assoc(state, 'chartState', chartState),
	'chart-set-average-cohort-post!': (serverBus, state, newState, id, thunk) =>
		serverBus.next(['chart-average-data', getChartOffsets(newState.columns[id]), thunk]),
	'chart-set-average-post!': (serverBus, state, newState, offsets, thunk) =>
		serverBus.next(['chart-average-data', Rx.Observable.of(offsets, Rx.Scheduler.async), thunk]),
	'sample-search': (state, text) => _.assoc(state, 'sampleSearch', text),
	'vizSettings-open': (state, id) => _.assoc(state, 'openVizSettings', id),
	'sortDirection': (state, id, newDir) =>
		_.assocIn(state, ['columns', id, 'sortDirection'], newDir),
	'allowOverSamples': (state, aos) => _.assoc(state, 'allowOverSamples', aos),
	'allowOverSamples-post!': (serverBus, state, newState, aos) =>
		fetchSamples(serverBus, userServers(newState), newState.cohort, aos),
	showWelcome: (state, show) => _.assoc(state, 'showWelcome', show),
	wizardMode: (state, mode) => _.assoc(state, 'wizardMode', mode),
	viewportWidth: (state, width) => _.assoc(state, 'defaultWidth', defaultWidth(width)),
	// Due to wonky react-bootstrap handlers, xzoom can occur after remove, so
	// check that the column exists before updating.
	'xzoom': (state, id, xzoom) => _.updateIn(state, ['columns', id],
			c => c ? _.assoc(c, 'xzoom', xzoom) : c)
};

module.exports = compose(
		mount(make(spreadsheetControls), ['spreadsheet']),
		make(controls));
