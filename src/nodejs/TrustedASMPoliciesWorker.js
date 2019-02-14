/* jshint esversion: 6 */
/* jshint node: true */
'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const url = require('url');
const path = require('path');
const pollDelay = 2000;
const AVAILABLE = 'AVAILABLE';
const REQUESTED = 'REQUESTED';
const EXPORTING = 'EXPORTING';
const DOWNLOADING = 'DOWNLOADING';
const UPLOADING = 'UPLOADING';
const IMPORTING = 'IMPORTING';
const FINISHED = 'COMPLETED';
const FAILED = 'FAILURE';
const ERROR = 'ERROR';
const UNDISCOVERED = 'UNDISCOVERED';
const UNKNOWN = 'UNKNOWN';
const DEVICEGROUP_PREFIX = 'TrustProxy_';

const TASKTIMEOUT = 120000;

const downloadDirectory = '/var/tmp';
const VALIDDOWNLOADPROTOCOLS = ['file:', 'http', 'https:'];
const deviceGroupsUrl = 'http://localhost:8100/mgmt/shared/resolver/device-groups';
const localauth = 'Basic ' + new Buffer('admin:').toString('base64');

let inFlight = {};

// polyfill old node to include [].includes
if (!Array.prototype.includes) {
    Object.defineProperty(Array.prototype, 'includes', {
        value: function (searchElement, fromIndex) {
            if (this === null) {
                throw new TypeError('"this" is null or not defined');
            }
            var o = Object(this);
            var len = o.length >>> 0;
            if (len === 0) {
                return false;
            }
            var n = fromIndex | 0;
            var k = Math.max(n >= 0 ? n : len - Math.abs(n), 0);

            function sameValueZero(x, y) {
                return x === y || (typeof x === 'number' && typeof y === 'number' && isNaN(x) && isNaN(y));
            }
            while (k < len) {
                if (sameValueZero(o[k], searchElement)) {
                    return true;
                }
                k++;
            }
            return false;
        }
    });
}

/**
 * Upload Worker
 *
 * Uploads specified files to a specified server.
 */
class TrustedASMPoliciesWorker {
    constructor() {
        this.WORKER_URI_PATH = "shared/TrustedASMPolicies";
        this.isPassThrough = true;
        this.isPublic = true;
    }

    /**
     * Get can take 3 query params (tragetHost, targetPort, name)
     * example: /shared/TrustedASMPolicies?targetHost=10.144.72.186&targetPort=443&name=linux-high
     * @param {RestOperation} restOperation
     */
    onGet(restOperation) {
        const paths = restOperation.uri.pathname.split('/');
        const query = restOperation.getUri().query;

        let targetDevice = null;
        let sourceDevice = null;
        let policyId = null;
        let policyName = null;

        if (query.targetHost) {
            targetDevice = query.targetHost;
        } else if (query.targetUUID) {
            targetDevice = query.targetUUID;
        } else if (paths.length > 3) {
            targetDevice = paths[3];
        }

        if (query.sourceHost) {
            sourceDevice = query.sourceHost;
        } else if (query.sourceUUID) {
            sourceDevice = query.sourceUUID;
        }

        if (query.policyName) {
            policyName = query.policyName;
        }

        if (query.policyId) {
            policyId = query.policyId;
        } else if (paths.length > 4) {
            policyId = paths[4];
        }

        if (sourceDevice) {
            if (targetDevice) {
                const err = new Error(`target device should be defined when defining source device`);
                err.httpStatusCode = 400;
                restOperation.fail(err);
            } else if (policyId || policyName) {
                this.validateTarget(sourceDevice)
                    .then((source) => {
                        this.getPoliciesOnBigIP(source.targetHost, source.targetPort)
                            .then((policies) => {
                                let policyFound = false;
                                policies.map((policy) => {
                                    if (!policyFound) {
                                        if (policy.id == policyId || policy.name == policyName) {
                                            policyFound = true;
                                            this.exportPolicyFromBigIP(source.targetHost, source.targetPort, policy.id)
                                                .then(() => {
                                                    const policyFileName = 'exportedPolicy_' + policy.id + '.xml';
                                                    this.downloadPolicyFileFromBigIP(source.targetHost, source.targetPort, policyFileName)
                                                        .then(() => {
                                                            this.getPolicyFileContentAndDelete(policyFileName)
                                                                .then((policyContent) => {
                                                                    restOperation.statusCode = 200;
                                                                    restOperation.setHeaders({
                                                                        ContentType: 'text/xml',
                                                                        ContentDisposition: 'attachment',
                                                                        filename: policyName + '.xml'
                                                                    });
                                                                    restOperation.body = policyContent;
                                                                    this.completeRestOperation(restOperation);
                                                                })
                                                                .catch((err) => {
                                                                    err.httpStatusCode = 500;
                                                                    restOperation.fail(err);
                                                                });
                                                        })
                                                        .catch((err) => {
                                                            err.httpStatusCode = 500;
                                                            restOperation.fail(err);
                                                        });
                                                })
                                                .catch((err) => {
                                                    err.httpStatusCode = 500;
                                                    restOperation.fail(err);
                                                });
                                        }
                                    }
                                });
                                if (!policyFound) {
                                    const policyError = new Error('could not find policy');
                                    policyError.httpStatusCode = 404;
                                    restOperation.fail(policyError);
                                }
                            })
                            .catch((err) => {
                                err.httpStatusCode = 400;
                                restOperation.fail(err);
                            });
                    });
            } else {
                const err = new Error(`you must supply either a policyName or policyId to export`);
                err.httpStatusCode = 400;
                restOperation.fail(err);
            }
        } else {
            this.validateTarget(targetDevice)
                .then((target) => {
                    this.getPoliciesOnBigIP(target.targetHost, target.targetPort)
                        .then((policies) => {
                            if (policyName || policyId) {
                                let policyFound = false;
                                policies.map((policy) => {
                                    if (!policyFound) {
                                        if (policyName && policy.name.startsWith(policyName)) {
                                            restOperation.statusCode = 200;
                                            restOperation.setContentType('application/json');
                                            restOperation.body = policy;
                                            this.completeRestOperation(restOperation);
                                            policyFound = true;
                                        }
                                        if (policyId && policy.id == policyId) {
                                            restOperation.statusCode = 200;
                                            restOperation.setContentType('application/json');
                                            restOperation.body = policy;
                                            this.completeRestOperation(restOperation);
                                            policyFound = true;
                                        }
                                    }
                                });
                                if (!policyFound) {
                                    const err = new Error(`no policy with matching policyName or policyId found.`);
                                    err.httpStatusCode = 404;
                                    restOperation.fail(err);
                                }
                            } else {
                                restOperation.statusCode = 200;
                                restOperation.setContentType('application/json');
                                restOperation.body = policies;
                                this.completeRestOperation(restOperation);
                            }
                        })
                        .catch((err) => {
                            err.httpStatusCode = 400;
                            restOperation.fail(err);
                        });
                })
                .catch((err) => {
                    err.httpStatusCode = 404;
                    restOperation.fail(err);
                });
        }

    }
    /**
     * Post can take 5 query params (sourceHost, url, tragetHost, policyId, policeName, targetPolicyName)
     * exemple: /shared/TrustedASMPolicies?sourceHost=10.144.72.135&sourcePort=443&targetHost=10.144.72.186&targetPort=443&policyName=linux-high&targetPolicyName=imported-linux-high
     * @param {RestOperation} restOperation
     */
    onPost(restOperation) {
        const query = restOperation.getUri().query;

        let sourceDevice = null;
        let sourceUrl = null;
        let targetDevice = null;
        let policyId = null;
        let policyName = null;
        let targetPolicyName = null;

        if (query.sourceHost) {
            sourceDevice = query.sourceHost;
        } else if (query.sourceUUID) {
            sourceDevice = query.sourceUUID;
        }

        if (query.url) {
            sourceUrl = query.url;
        }

        if (query.targetHost) {
            targetDevice = query.targetHost;
        } else if (query.targetUUID) {
            targetDevice = query.targetUUID;
        }

        if (query.policyId) {
            policyId = query.policyId;
        }

        if (query.policyName) {
            policyName = query.policyName;
        }

        if (query.targetPolicyName) {
            targetPolicyName = query.targetPolicyName;
        }

        const createBody = restOperation.getBody();
        if (createBody.hasOwnProperty('sourceHost')) {
            sourceDevice = createBody.sourceHost;
        }
        if (createBody.hasOwnProperty('sourceUUID')) {
            sourceDevice = createBody.sourceUUID;
        }
        if (createBody.hasOwnProperty('url')) {
            sourceUrl = createBody.url;
        }
        if (createBody.hasOwnProperty('targetHost')) {
            targetDevice = createBody.targetHost;
        }
        if (createBody.hasOwnProperty('targetUUID')) {
            targetDevice = createBody.targetUUID;
        }
        if (createBody.hasOwnProperty('policyId')) {
            policyId = createBody.policyId;
        }
        if (createBody.hasOwnProperty('policyName')) {
            policyName = createBody.policyName;
        }
        if (createBody.hasOwnProperty('targetPolicyName')) {
            targetPolicyName = createBody.targetPolicyName;
        }

        if (sourceUrl) {
            if (!targetPolicyName) {
                const policyResolveError = new Error('must supply targetPolicyName if using URL as the source of the policy');
                this.logger.severe(policyResolveError.message);
                policyResolveError.httpStatusCode = 404;
                restOperation.fail(policyResolveError);
            } else {
                if (!targetDevice) {
                    const targetError = new Error('must supply a targetHost or targetUUID to import policy from url');
                    this.logger.severe(targetError.message);
                    targetError.httpStatusCode = 404;
                    restOperation.fail(targetError);
                }
                const sourcePolicyId = targetPolicyName;
                const policyFileName = 'exportedPolicy_' + sourcePolicyId + '.xml';
                this.validateTarget(targetDevice)
                    .then((target) => {
                        const inFlightIndex = `${target.targetHost}:${target.targetPort}:${sourcePolicyId}`;
                        let returnPolicy = {
                            id: sourceUrl,
                            name: targetPolicyName,
                            enforcementMode: UNKNOWN,
                            state: REQUESTED,
                            path: UNKNOWN
                        };
                        inFlight[inFlightIndex] = returnPolicy;
                        this.updateInflightState(target.targetHost, target.targetPort, sourcePolicyId, DOWNLOADING);
                        this.downloadPolicyFile(sourceUrl, policyFileName)
                            .then(() => {
                                this.updateInflightState(target.targetHost, target.targetPort, sourcePolicyId, UPLOADING);
                                this.uploadPolicyFileToBigIP(target.targetHost, target.targetPort, policyFileName)
                                    .then(() => {
                                        this.updateInflightState(target.targetHost, target.targetPort, sourcePolicyId, IMPORTING);
                                        this.importPolicyToBigIP(target.targetHost, target.targetPort, sourcePolicyId, targetPolicyName)
                                            .then((targetPolicyId) => {
                                                delete inFlight[inFlightIndex];
                                                this.applyPolicyOnBigIP(target.targetHost, target.targetPort, targetPolicyId)
                                                    .then(() => {
                                                        this.logger.info('policy ' + sourcePolicyId + ' imported and applied on ' + target.targetHost + ':' + target.targetPort);
                                                    })
                                                    .catch((err) => {
                                                        this.logger.severe('error applying policy file ' + sourcePolicyId + ' to ' + target.targetHost + ':' + target.targetPort + ' - ' + err.message);
                                                        this.updateInflightState(target.targetHost, target.targetPort, sourcePolicyId, ERROR);
                                                    });
                                            })
                                            .catch((err) => {
                                                this.logger.severe('error importing policy file ' + sourcePolicyId + ' to ' + target.targetHost + ':' + target.targetPort + ' - ' + err.message);
                                                this.updateInflightState(target.targetHost, target.targetPort, sourcePolicyId, ERROR);
                                            });
                                    })
                                    .catch((err) => {
                                        this.logger.severe('error uploading policy file ' + policyFileName + ' to ' + target.targetHost + ':' + target.targetPort + ' - ' + err.message);
                                        this.updateInflightState(target.targetHost, target.targetPort, sourcePolicyId, ERROR);
                                    });
                            })
                            .catch((err) => {
                                this.logger.severe('error downloading policy file ' + policyFileName + ' from ' + sourceUrl + ' - ' + err.message);
                                this.updateInflightState(target.targetHost, target.targetPort, sourcePolicyId, ERROR);
                            });
                        restOperation.statusCode = 202;
                        restOperation.setContentType('application/json');
                        restOperation.body = inFlight[inFlightIndex];
                        this.completeRestOperation(restOperation);
                    })
                    .catch((err) => {
                        this.logger.severe(err.message);
                        err.httpStatusCode = 400;
                        restOperation.fail(err);
                    });
            }
        } else {
            this.validateTarget(sourceDevice)
                .then((source) => {
                    this.getPoliciesOnBigIP(source.targetHost, source.targetPort)
                        .then((policies) => {
                            let sourcePolicyId = null;
                            let sourcePolicyName = null;
                            let sourcePolicyEnforcementMode = null;
                            let sourcePolicyFullPath = null;
                            policies.map((policy) => {
                                if (policyId && policy.id == policyId) {
                                    sourcePolicyId = policy.id;
                                    sourcePolicyName = policy.name;
                                    sourcePolicyEnforcementMode = policy.enforcementMode;
                                    sourcePolicyFullPath = policy.fullPath;
                                    if (!targetPolicyName) {
                                        targetPolicyName = sourcePolicyName;
                                    }
                                } else if (policyName && policy.name == policyName) {
                                    sourcePolicyId = policy.id;
                                    sourcePolicyName = policy.name;
                                    sourcePolicyEnforcementMode = policy.enforcementMode;
                                    sourcePolicyFullPath = policy.fullPath;
                                    if (!targetPolicyName) {
                                        targetPolicyName = sourcePolicyName;
                                    }
                                }
                            });
                            if (!sourcePolicyId) {
                                const policyResolveError = new Error(`source policy could not be found on ${source.targetHost}:${source.targetPort}`);
                                policyResolveError.httpStatusCode = 404;
                                restOperation.fail(policyResolveError);
                            } else {
                                this.validateTarget(targetDevice)
                                    .then((target) => {
                                        this.getPoliciesOnBigIP(target.targetHost, target.targetPort)
                                            .then((policies) => {
                                                policies.map((policy) => {
                                                    if (policy.id == sourcePolicyId) {
                                                        const policyTargetError = new Error(`source policy ${sourcePolicyId} is already on ${target.targetHost}:${target.targetPort}`);
                                                        policyTargetError.httpStatusCode = 409;
                                                        restOperation.fail(policyTargetError);
                                                    }
                                                });
                                                const inFlightIndex = `${target.targetHost}:${target.targetPort}:${sourcePolicyId}`;
                                                let returnPolicy = {
                                                    id: sourcePolicyId,
                                                    name: sourcePolicyName,
                                                    enforcementMode: sourcePolicyEnforcementMode,
                                                    state: REQUESTED,
                                                    path: sourcePolicyFullPath
                                                };
                                                inFlight[inFlightIndex] = returnPolicy;
                                                this.updateInflightState(target.targetHost, target.targetPort, sourcePolicyId, EXPORTING);
                                                this.exportPolicyFromBigIP(source.targetHost, source.targetPort, sourcePolicyId)
                                                    .then(() => {
                                                        const policyFileName = 'exportedPolicy_' + sourcePolicyId + '.xml';
                                                        this.updateInflightState(target.targetHost, target.targetPort, sourcePolicyId, DOWNLOADING);
                                                        this.downloadPolicyFileFromBigIP(source.targetHost, source.targetPort, policyFileName)
                                                            .then(() => {
                                                                this.updateInflightState(target.targetHost, target.targetPort, sourcePolicyId, UPLOADING);
                                                                this.uploadPolicyFileToBigIP(target.targetHost, target.targetPort, policyFileName)
                                                                    .then(() => {
                                                                        this.updateInflightState(target.targetHost, target.targetPort, sourcePolicyId, IMPORTING);
                                                                        this.importPolicyToBigIP(target.targetHost, target.targetPort, sourcePolicyId, targetPolicyName)
                                                                            .then((targetPolicyId) => {
                                                                                delete inFlight[inFlightIndex];
                                                                                this.applyPolicyOnBigIP(target.targetHost, target.targetPort, targetPolicyId)
                                                                                    .then(() => {
                                                                                        this.logger.info('policy ' + sourcePolicyId + ' imported and applied on ' + target.targetHost + ':' + target.targetPort);
                                                                                    })
                                                                                    .catch((err) => {
                                                                                        this.logger.severe('error applying policy file ' + sourcePolicyId + ' to ' + target.targetHost + ':' + target.targetPort + ' - ' + err.message);
                                                                                        this.updateInflightState(target.targetHost, target.targetPort, sourcePolicyId, ERROR);
                                                                                    });
                                                                            })
                                                                            .catch((err) => {
                                                                                this.logger.severe('error importing policy file ' + sourcePolicyId + ' to ' + target.targetHost + ':' + target.targetPort + ' - ' + err.message);
                                                                                this.updateInflightState(target.targetHost, target.targetPort, sourcePolicyId, ERROR);
                                                                            });
                                                                    })
                                                                    .catch((err) => {
                                                                        this.logger.severe('error uploading policy file ' + policyFileName + ' to ' + target.targetHost + ':' + target.targetPort + ' - ' + err.message);
                                                                        this.updateInflightState(target.targetHost, target.targetPort, sourcePolicyId, ERROR);
                                                                    });
                                                            })
                                                            .catch((err) => {
                                                                this.logger.severe('error downloading policy file ' + policyFileName + ' from ' + source.targetHost + ':' + source.targetPort + ' - ' + err.message);
                                                                this.updateInflightState(target.targetHost, target.targetPort, sourcePolicyId, ERROR);
                                                            });
                                                    })
                                                    .catch((err) => {
                                                        this.logger.severe('error exporting policy ' + sourcePolicyId + ' from ' + source.targetHost + ':' + source.targetPort + ' - ' + err.message + ' - ' + err.message);
                                                        this.updateInflightState(target.targetHost, target.targetPort, sourcePolicyId, ERROR);
                                                    });
                                                restOperation.statusCode = 202;
                                                restOperation.setContentType('application/json');
                                                restOperation.body = inFlight[inFlightIndex];
                                                this.completeRestOperation(restOperation);
                                            });
                                    })
                                    .catch((err) => {
                                        this.logger.severe(err.message);
                                        err.httpStatusCode = 400;
                                        restOperation.fail(err);
                                    });
                            }
                        })
                        .catch((err) => {
                            const getPoliciesError = new Error(`could not fetch policies from ${source.targetHost}:${source.targetPort} - ${err.message}`);
                            getPoliciesError.httpStatusCode = 500;
                            restOperation.fail(err);
                        });
                })
                .catch((err) => {
                    err.httpStatusCode = 400;
                    restOperation.fail(err);
                });
        }
    }
    /**
     * Delete can take 4 query params (tragetHost, targetPort, policyId, policyName)
     * example: /shared/TrustedASMPolicies?targetHost=10.144.72.186&targetPort=443&policyName=linux-high
     * @param {RestOperation} restOperation
     */
    onDelete(restOperation) {
        const paths = restOperation.uri.pathname.split('/');
        const query = restOperation.getUri().query;

        let targetDevice = null;
        let policyId = null;
        let policyName = null;

        if (query.targetHost) {
            targetDevice = query.targetHost;
        } else if (query.targetUUID) {
            targetDevice = query.targetUUID;
        } else if (paths.length > 3) {
            targetDevice = paths[3];
        }

        if (query.policyId) {
            policyId = query.policyId;
        } else if (paths.length > 4) {
            policyId = paths[4];
        }

        if (query.policyName) {
            policyName = query.policyName;
        }

        this.validateTarget(targetDevice)
            .then((target) => {
                this.getPoliciesOnBigIP(target.targetHost, target.targetPort)
                    .then((policies) => {
                        let targetPolicyId = null;
                        let targetPolicyState = null;
                        policies.map((policy) => {
                            if (policyId && policy.id == policyId) {
                                targetPolicyId = policy.id;
                                targetPolicyState = policy.state;
                            } else if (policyName && policy.name == policyName) {
                                targetPolicyId = policy.id;
                                targetPolicyState = policy.state;
                            }
                        });
                        if (!targetPolicyId) {
                            const policyResolveError = new Error(`policy could not be found on ${target.targetHost}:${target.targetPort}`);
                            policyResolveError.httpStatusCode = 404;
                            restOperation.fail(policyResolveError);
                        } else {
                            const inFlightIndex = `${target.targetHost}:${target.targetPort}:${targetPolicyId}`;
                            if (Object.keys(inFlight).includes(inFlightIndex)) {
                                delete inFlight[inFlightIndex];
                            }
                            if (targetPolicyState == AVAILABLE) {
                                this.deletePolicyOnBigIP(target.targetHost, target.targetPort, targetPolicyId)
                                    .then(() => {
                                        restOperation.statusCode = 200;
                                        restOperation.body = {
                                            msg: `policy removed on target ${target.targetHost}:${target.targetPort}`
                                        };
                                        this.completeRestOperation(restOperation);
                                    })
                                    .catch((err) => {
                                        err.httpStatusCode = 500;
                                        restOperation.fail(err);
                                    });
                            } else {
                                restOperation.statusCode = 200;
                                restOperation.body = {
                                    msg: `policy removed on target ${target.targetHost}:${target.targetPort}`
                                };
                                this.completeRestOperation(restOperation);
                            }
                        }

                    })
                    .catch((err) => {
                        err.httpStatusCode = 500;
                        restOperation.fail(err);
                    });
            })
            .catch((err) => {
                err.httpStatusCode = 400;
                restOperation.fail(err);
            });
    }

    getPoliciesOnBigIP(targetHost, targetPort) {
        return new Promise((resolve, reject) => {
            let returnPolicies = [];
            Object.keys(inFlight).map((inFlightIndex) => {
                returnPolicies.push(inFlight[inFlightIndex]);
            });
            this.restRequestSender.sendGet(this.getQueryPoliciesRestOp(targetHost, targetPort))
                .then((response) => {
                    let policies = response.getBody();
                    if (policies.hasOwnProperty('items')) {
                        policies.items.map((policy) => {
                            let returnPolicy = {
                                id: policy.id,
                                name: policy.name,
                                enforcementMode: policy.enforcementMode,
                                state: AVAILABLE,
                                path: policy.fullPath
                            };
                            if (!policy.active) {
                                returnPolicy.state = 'INACTIVE';
                            }
                            returnPolicies.push(returnPolicy);
                        });
                    } else {
                        reject(new Error('policies request did not return a list of policies: ' + JSON.stringify(policies)));
                    }
                    resolve(returnPolicies);
                })
                .catch((err) => {
                    if (err.message.includes('java.net.ConnectException: Connection refused')) {
                        reject(new Error('ASM is not provisioned on ' + targetHost + ':' + targetPort));
                    } else {
                        reject(err);
                    }
                });
        });
    }

    /* jshint ignore:start */
    updateInflightState(targetHost, targetPort, policyId, state) {
        const inFlightIndex = `${targetHost}:${targetPort}:${policyId}`;
        if (!inFlight.hasOwnProperty(inFlightIndex)) {
            inFlight[inFlightIndex] = {
                id: policyId,
                name: 'UNKNOWN',
                enforcementMode: 'UNKNOWN',
                state: state,
                path: 'UNKNOWN'
            }
        } else {
            inFlight[inFlightIndex].state = state;
        }
    }
    /* jshint ignore:end */

    /* jshint ignore:start */
    exportPolicyFromBigIP(sourceHost, sourcePort, policyId) {
        return new Promise((resolve, reject) => {
            this.restRequestSender.sendPost(this.getExportRestOp(sourceHost, sourcePort, policyId))
                .then((response) => {
                    let task = response.getBody();
                    if (task.hasOwnProperty('id')) {
                        this.logger.info('exporting policy ' + policyId + ' from ' + sourceHost + ':' + sourcePort);
                        this.pollTaskUntilFinishedAndDelete(sourceHost, sourcePort, task.id, 'export')
                            .then(() => {
                                resolve(true);
                            })
                            .catch((err) => {
                                reject(err);
                            })
                    } else {
                        reject(new Error('policy export request did not return a task ID: ' + JSON.stringify(task)));
                    }
                })
                .catch((err) => {
                    reject(err);
                })
        });
    }
    /* jshint ignore:end */

    /* jshint ignore:start */
    importPolicyToBigIP(targetHost, targetPort, policyId, policyName) {
        return new Promise((resolve, reject) => {
            this.restRequestSender.sendPost(this.getImportRestOp(targetHost, targetPort, policyId, policyName))
                .then((response) => {
                    let task = response.getBody();
                    if (task.hasOwnProperty('id')) {
                        this.logger.info('importing policy ' + policyId + ' to ' + targetHost + ':' + targetPort + ' task ID:' + task.id);
                        this.pollTaskUntilFinishedAndDelete(targetHost, targetPort, task.id, 'import')
                            .then((targetPolicyId) => {
                                resolve(targetPolicyId);
                            })
                            .catch((err) => {
                                reject(err);
                            })
                    } else {
                        reject(new Error('policy import request did not return a task ID: ' + JSON.stringify(task)));
                    }
                })
                .catch((err) => {
                    reject(err);
                })
        });
    }
    /* jshint ignore:end */

    /* jshint ignore:start */
    applyPolicyOnBigIP(targetHost, targetPort, policyId) {
        return new Promise((resolve, reject) => {
            this.restRequestSender.sendPost(this.getApplyPolicyRestOp(targetHost, targetPort, policyId))
                .then((response) => {
                    let task = response.getBody();
                    if (task.hasOwnProperty('id')) {
                        this.logger.info('applying policy ' + policyId + ' to ' + targetHost + ':' + targetPort + ' task ID:' + task.id);
                        this.pollTaskUntilFinishedAndDelete(targetHost, targetPort, task.id, 'apply')
                            .then(() => {
                                resolve(true);
                            })
                            .catch((err) => {
                                reject(err);
                            })
                    } else {
                        reject(new Error('policy import request did not return a task ID: ' + JSON.stringify(task)));
                    }
                })
                .catch((err) => {
                    reject(err);
                })
        });
    }
    /* jshint ignore:end */

    /* jshint ignore:start */
    deletePolicyOnBigIP(targetHost, targetPort, policyId) {
        return new Promise((resolve, reject) => {
            this.restRequestSender.sendDelete(this.getDeletePolicyRestOp(targetHost, targetPort, policyId))
                .then(() => {
                    resolve(true);
                })
                .catch((err) => {
                    reject(err);
                })
        });
    }
    /* jshint ignore:end */

    getQueryPoliciesRestOp(targetHost, targetPort) {
        let protocol = 'https';
        if (targetHost == 'localhost') {
            protocol = 'http';
        }
        const destUri = `${protocol}://${targetHost}:${targetPort}/mgmt/tm/asm/policies?$select=id,name,fullPath,enforcementMode,active`;
        const op = this.restOperationFactory.createRestOperationInstance()
            .setUri(url.parse(destUri))
            .setContentType("application/json");
        if (targetHost == 'localhost') {
            op.setBasicAuthorization(localauth);
            op.setIsSetBasicAuthHeader(true);
        } else {
            op.setIdentifiedDeviceRequest(true);
        }
        return op;
    }

    getExportRestOp(sourceHost, sourcePort, policyId) {
        let protocol = 'https';
        if (sourceHost == 'localhost') {
            protocol = 'http';
        }
        const destUri = `${protocol}://${sourceHost}:${sourcePort}/mgmt/tm/asm/tasks/export-policy`;
        const destBody = {
            filename: "exportedPolicy_" + policyId + ".xml",
            minimal: true,
            policyReference: {
                link: "http://localhost/mgmt/tm/asm/policies/" + policyId
            }
        };
        const op = this.restOperationFactory.createRestOperationInstance()
            .setUri(url.parse(destUri))
            .setContentType("application/json")
            .setMethod('Post')
            .setBody(destBody);
        if (sourceHost == 'localhost') {
            op.setBasicAuthorization(localauth);
            op.setIsSetBasicAuthHeader(true);
        } else {
            op.setIdentifiedDeviceRequest(true);
        }
        return op;
    }

    getImportRestOp(targetHost, targetPort, policyId, policyName) {
        let protocol = 'https';
        if (targetHost == 'localhost') {
            protocol = 'http';
        }
        const destUri = `${protocol}://${targetHost}:${targetPort}/mgmt/tm/asm/tasks/import-policy`;
        const destBody = {
            filename: "exportedPolicy_" + policyId + ".xml",
            name: policyName
        };
        const op = this.restOperationFactory.createRestOperationInstance()
            .setUri(url.parse(destUri))
            .setContentType("application/json")
            .setMethod('Post')
            .setBody(destBody);
        if (targetHost == 'localhost') {
            op.setBasicAuthorization(localauth);
            op.setIsSetBasicAuthHeader(true);
        } else {
            op.setIdentifiedDeviceRequest(true);
        }
        return op;
    }

    getApplyPolicyRestOp(sourceHost, sourcePort, policyId) {
        let protocol = 'https';
        if (sourceHost == 'localhost') {
            protocol = 'http';
        }
        const destUri = `${protocol}://${sourceHost}:${sourcePort}/mgmt/tm/asm/tasks/apply-policy`;
        const destBody = {
            policyReference: {
                link: "http://localhost/mgmt/tm/asm/policies/" + policyId
            }
        };
        const op = this.restOperationFactory.createRestOperationInstance()
            .setUri(url.parse(destUri))
            .setContentType("application/json")
            .setMethod('Post')
            .setBody(destBody);
        if (sourceHost == 'localhost') {
            op.setBasicAuthorization(localauth);
            op.setIsSetBasicAuthHeader(true);
        } else {
            op.setIdentifiedDeviceRequest(true);
        }
        return op;
    }

    getDeletePolicyRestOp(targetHost, targetPort, policyId) {
        let protocol = 'https';
        if (targetHost == 'localhost') {
            protocol = 'http';
        }
        const destUri = `${protocol}://${targetHost}:${targetPort}/mgmt/tm/asm/policies/${policyId}`;
        const op = this.restOperationFactory.createRestOperationInstance()
            .setUri(url.parse(destUri))
            .setContentType("application/json")
            .setMethod('Delete');
        if (targetHost == 'localhost') {
            op.setBasicAuthorization(localauth);
            op.setIsSetBasicAuthHeader(true);
        } else {
            op.setIdentifiedDeviceRequest(true);
        }
        return op;
    }

    getTaskStatusRestOp(targetHost, targetPort, taskId, type) {
        let protocol = 'https';
        if (targetHost == 'localhost') {
            protocol = 'http';
        }
        const destUri = `${protocol}://${targetHost}:${targetPort}/mgmt/tm/asm/tasks/${type}-policy/${taskId}`;
        this.logger.info('retrieving task status for ' + destUri);
        const op = this.restOperationFactory.createRestOperationInstance()
            .setUri(url.parse(destUri))
            .setContentType("application/json");
        if (targetHost == 'localhost') {
            op.setBasicAuthorization(localauth);
            op.setIsSetBasicAuthHeader(true);
        } else {
            op.setIdentifiedDeviceRequest(true);
        }
        return op;
    }

    getDeleteTaskRestOp(targetHost, targetPort, taskId, type) {
        let protocol = 'https';
        if (targetHost == 'localhost') {
            protocol = 'http';
        }
        const destUri = `${protocol}://${targetHost}:${targetPort}/mgmt/tm/asm/tasks/${type}-policy/${taskId}`;
        const op = this.restOperationFactory.createRestOperationInstance()
            .setUri(url.parse(destUri))
            .setContentType("application/json")
            .setMethod("Delete");
        if (targetHost == 'localhost') {
            op.setBasicAuthorization(localauth);
            op.setIsSetBasicAuthHeader(true);
        } else {
            op.setIdentifiedDeviceRequest(true);
        }
        return op;
    }

    validateTarget(targetDevice) {
        return new Promise((resolve, reject) => {
            if (!targetDevice) {
                resolve({
                    targetHost: 'localhost',
                    targetPort: 8100
                });
            }
            if (targetDevice == 'localhost') {
                resolve({
                    targetHost: 'localhost',
                    targetPort: 8100
                });
            }
            this.getDevices()
                .then((devices) => {
                    devices.map((device) => {
                        if (device.targetHost == targetDevice || device.targetUUID == targetDevice) {
                            resolve(device);
                        }
                    });
                    reject(new Error('target ' + targetDevice + ' is not a trusted device.'));
                });
        });
    }

    /**
     * Request to get all trusted device groups
     * @returns Promise when request completes
     */
    getDeviceGroups() {
        return new Promise((resolve, reject) => {
            const deviceGroupsGetRequest = this.restOperationFactory.createRestOperationInstance()
                .setUri(this.url.parse(deviceGroupsUrl))
                .setBasicAuthorization(localauth)
                .setIsSetBasicAuthHeader(true);
            this.restRequestSender.sendGet(deviceGroupsGetRequest)
                .then((response) => {
                    let respBody = response.getBody();
                    if (!respBody.hasOwnProperty('items')) {
                        // we need to create a device group for our desired devices
                        Promise.all([this.resolveDeviceGroup()])
                            .then((deviceGroupName) => {
                                resolve(deviceGroupName);
                            })
                            .catch(err => {
                                this.logger.severe('could not create device group');
                                reject(err);
                            });
                    }
                    const returnDeviceGroups = [];
                    respBody.items.map((deviceGroup) => {
                        if (deviceGroup.groupName.startsWith(DEVICEGROUP_PREFIX)) {
                            returnDeviceGroups.push(deviceGroup);
                        }
                    });
                    if (!returnDeviceGroups) {
                        this.createDeviceGroup(DEVICEGROUP_PREFIX + '0')
                            .then((response) => {
                                resolve([response.groupName]);
                            })
                            .catch((err) => {
                                reject(err);
                            });
                    } else {
                        resolve(returnDeviceGroups);
                    }
                })
                .catch(err => {
                    this.logger.severe('could not get a list of device groups:' + err.message);
                    reject(err);
                });
        });
    }

    getDevices() {
        return new Promise((resolve, reject) => {
            const devices = [];
            this.getDeviceGroups()
                .then((deviceGroups) => {
                    const devicesPromises = [];
                    deviceGroups.map((devicegroup, indx) => {
                        const devicesGroupUrl = deviceGroupsUrl + '/' + devicegroup.groupName + '/devices';
                        const devicesGetRequest = this.restOperationFactory.createRestOperationInstance()
                            .setUri(this.url.parse(devicesGroupUrl))
                            .setBasicAuthorization(localauth)
                            .setIsSetBasicAuthHeader(true);
                        const devicesGetPromise = this.restRequestSender.sendGet(devicesGetRequest)
                            .then((response) => {
                                const devicesBody = response.getBody();
                                devicesBody.items.map((device, inc) => {
                                    if (device.hasOwnProperty('mcpDeviceName') ||
                                        device.state == UNDISCOVERED) {
                                        const returnDevice = {
                                            targetHost: device.address,
                                            targetPort: device.httpsPort,
                                            targetUUID: device.machineId,
                                            state: device.state
                                        };
                                        devices.push(returnDevice);
                                    }
                                });
                            })
                            .catch((err) => {
                                this.logger.severe('Error getting devices from device group:' + err.message);
                                reject(err);
                            });
                        devicesPromises.push(devicesGetPromise);
                    });
                    Promise.all(devicesPromises)
                        .then(() => {
                            resolve(devices);
                        })
                        .catch((err) => {
                            reject(err);
                        });
                })
                .catch((err) => {
                    this.logger.severe('Error getting device groups:' + err.message);
                    throw err;
                });
        });
    }

    pollTaskUntilFinishedAndDelete(targetHost, targetPort, taskId, type, timeout) {
        return new Promise((resolve, reject) => {
            if (!timeout) {
                timeout = TASKTIMEOUT;
            }
            const start = new Date().getTime();
            let stop = start + timeout;
            let returnData = {};

            const poll = () => {
                this.restRequestSender.sendGet(this.getTaskStatusRestOp(targetHost, targetPort, taskId, type))
                    .then((response) => {
                        const queryBody = response.getBody();
                        if (queryBody.hasOwnProperty('status')) {
                            if (queryBody.status === FINISHED) {
                                if (queryBody.hasOwnProperty('result') && queryBody.result.hasOwnProperty('policyReference')) {
                                    returnData = path.basename(queryBody.result.policyReference.link);
                                } else {
                                    returnData = queryBody;
                                }
                                this.restRequestSender.sendDelete(this.getDeleteTaskRestOp(targetHost, targetPort, taskId, type));
                                resolve(returnData);
                            } else if (queryBody.status === FAILED) {
                                reject(new Error('Task failed returning' + queryBody));
                            } else {
                                wait(pollDelay)
                                    .then(() => {
                                        if (new Date().getTime() < stop) {
                                            poll();
                                        } else {
                                            reject(new Error('Task did not reach ' + FINISHED + ' status. Instead returned: ' + JSON.stringify(queryBody)));
                                        }
                                    });
                            }
                        }
                    })
                    .catch((err) => {
                        reject(err);
                    });
            };

            setImmediate(poll);
        });
    }

    downloadPolicyFile(sourceUrl, policyFile) {
        return new Promise((resolve, reject) => {
            try {
                this.logger.info('downloading policy file:' + policyFile + ' from url:' + sourceUrl);
                if (!sourceUrl) {
                    resolve(false);
                }
                const filePath = `${downloadDirectory}/${policyFile}`;
                if (fs.existsSync()) {
                    const fstats = fs.statSync(filePath);
                    this.logger.info('file ' + policyFile + '(' + fstats.size + ' bytes) was deleted');
                    fs.unlinkSync(filePath);
                }
                const parsedUrl = url.parse(sourceUrl);
                if (VALIDDOWNLOADPROTOCOLS.includes(parsedUrl.protocol)) {
                    if (parsedUrl.protocol == 'file:') {
                        try {
                            copyFile(parsedUrl.pathname, true);
                            resolve(policyFile);
                        } catch (err) {
                            reject(err);
                        }
                    } else if (parsedUrl.protocol == 'http:') {
                        this.logger.info('downloading ' + sourceUrl);
                        let fws = fs.createWriteStream(filePath);
                        let request = http.get(sourceUrl, (response) => {
                                if (response.statusCode > 300 && response.statusCode < 400 && response.headers.location) {
                                    fs.unlinkSync(filePath);
                                    const redirectUrlParsed = url.parse(response.headers.location);
                                    let redirectUrl = parsedUrl.host + response.headers.location;
                                    if (redirectUrlParsed.hostname) {
                                        redirectUrl = response.headers.location;
                                    }
                                    this.logger.info('following download redirect to:' + redirectUrl);
                                    fws = fs.createWriteStream(filePath);
                                    request = https.get(redirectUrl, (response) => {
                                            this.logger.info('redirect has status: ' + response.statusCode + ' body:' + JSON.stringify(response.headers));
                                            response.pipe(fws);
                                            fws.on('finish', () => {
                                                fws.close();
                                                resolve(policyFile);
                                            });
                                        })
                                        .on('error', (err) => {
                                            this.logger.severe('error downloading url ' + redirectUrl + ' - ' + err.message);
                                            fws.close();
                                            fs.unlinkSync(filePath);
                                            resolve(false);
                                        });
                                } else {
                                    response.pipe(fws);
                                    fws.on('finish', () => {
                                        fws.close();
                                        resolve(policyFile);
                                    });
                                }
                            })
                            .on('error', (err) => {
                                this.logger.severe('error downloading url ' + sourceUrl + ' - ' + err.message);
                                fws.close();
                                fs.unlinkSync(filePath);
                                resolve(false);
                            });
                        request.end();
                    } else {
                        this.logger.info('downloading ' + sourceUrl);
                        process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = 0; // jshint ignore:line
                        let fws = fs.createWriteStream(filePath);
                        let request = https.get(sourceUrl, (response) => {
                                if (response.statusCode > 300 && response.statusCode < 400 && response.headers.location) {
                                    fs.unlinkSync(filePath);
                                    const redirectUrlParsed = url.parse(response.headers.location);
                                    let redirectUrl = parsedUrl.host + response.headers.location;
                                    if (redirectUrlParsed.hostname) {
                                        redirectUrl = response.headers.location;
                                    }
                                    this.logger.info('following download redirect to:' + redirectUrl);
                                    fws = fs.createWriteStream(filePath);
                                    request = https.get(redirectUrl, (response) => {
                                            this.logger.info('redirect has status: ' + response.statusCode + ' body:' + JSON.stringify(response.headers));
                                            response.pipe(fws);
                                            fws.on('finish', () => {
                                                fws.close();
                                                resolve(policyFile);
                                            });
                                        })
                                        .on('error', (err) => {
                                            this.logger.severe('error downloading url ' + redirectUrl + ' - ' + err.message);
                                            fws.close();
                                            fs.unlinkSync(filePath);
                                            resolve(false);
                                        });
                                } else {
                                    response.pipe(fws);
                                    fws.on('finish', () => {
                                        fws.close();
                                        resolve(policyFile);
                                    });
                                }
                            })
                            .on('error', (err) => {
                                this.logger.severe('error downloading url ' + sourceUrl + ' - ' + err.message);
                                fws.close();
                                fs.unlinkSync(filePath);
                                resolve(false);
                            });
                        request.end();
                    }
                } else {
                    const err = 'extension url must use the following protocols:' + JSON.stringify(VALIDDOWNLOADPROTOCOLS);
                    reject(new Error(err));
                }
            } catch (err) {
                reject(err);
            }
        });
    }

    downloadPolicyFileFromBigIP(sourceHost, sourcePort, policyFile) {
        return new Promise((resolve, reject) => {
            try {
                if (!policyFile) {
                    resolve(false);
                }
                this.logger.info('downloading policy file ' + policyFile + ' from ' + sourceHost + ':' + sourcePort);
                const filePath = `${downloadDirectory}/${policyFile}`;
                if (fs.existsSync(filePath)) {
                    const fstats = fs.statSync(filePath);
                    this.logger.info('file ' + policyFile + '(' + fstats.size + ' bytes) was deleted');
                    fs.unlinkSync(filePath);
                }
                let options = {
                    host: sourceHost,
                    port: sourcePort,
                    path: `/mgmt/tm/asm/file-transfer/downloads/${policyFile}`,
                    method: 'GET'
                };
                let fws = fs.createWriteStream(filePath);
                if (sourceHost == 'localhost') {
                    options.port = 8100;
                    options.headers = {
                        Authorization: localauth
                    };
                    let request = http.request(options, (response) => {
                        if (response.statusCode > 399) {
                            const downloadError = new Error('error downloading policy ' + policyFile + ' from ' + sourceHost + ':' + sourcePort + ' - ' + JSON.stringify(response));
                            this.logger.severe(downloadError.message);
                            fws.close();
                            fs.unlinkSync(filePath);
                            reject(downloadError);
                        } else {
                            response.pipe(fws);
                            fws.on('finish', () => {
                                fws.close();
                                resolve(policyFile);
                            });
                        }
                    }).on('error', (err) => {
                        this.logger.severe('error downloading policy ' + policyFile + ' from ' + sourceHost + ':' + sourcePort + ' - ' + err.message);
                        fws.close();
                        fs.unlinkSync(filePath);
                        reject(err);
                    });
                    request.end();
                } else {
                    this.getToken(sourceHost)
                        .then((JSONToken) => {
                            const token = JSON.parse(JSONToken);
                            options.path = `${options.path}?${token.queryParam}`;
                            process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = 0; // jshint ignore:line
                            let request = https.request(options, (response) => {
                                response.pipe(fws);
                                fws.on('finish', () => {
                                    fws.close();
                                    resolve(policyFile);
                                });
                            }).on('error', (err) => {
                                this.logger.severe('error downloading policy ' + policyFile + ' from ' + sourceHost + ':' + sourcePort + ' - ' + err.message);
                                fws.close();
                                fs.unlinkSync(filePath);
                                resolve(false);
                            });
                            request.end();
                        });
                }
            } catch (err) {
                reject(err);
            }
        });
    }

    getPolicyFileContentAndDelete(policyFile) {
        return new Promise((resolve, reject) => {
            const filePath = `${downloadDirectory}/${policyFile}`;
            if (fs.existsSync(filePath)) {
                resolve(fs.readFileSync(filePath, 'utf8'));
                fs.unlinkSync(filePath);
            } else {
                reject(new Error('file ' + filePath + ' was not found'));
            }
        });
    }

    uploadPolicyFileToBigIP(targetHost, targetPort, policyFile) {
        return new Promise((resolve, reject) => {
            const filePath = `${downloadDirectory}/${policyFile}`;
            const fstats = fs.statSync(filePath);
            const CHUNK_SIZE = 512000;
            const postOptions = {
                hostname: targetHost,
                port: targetPort,
                path: `/mgmt/tm/asm/file-transfer/uploads/${policyFile}`,
                method: 'POST'
            };
            process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = 0; // jshint ignore:line
            let httplib = https;
            if (targetHost == 'localhost') {
                targetPort = 8100;
                httplib = http;
            }
            const uploadPart = (start, end) => {
                const headers = {
                    'Content-Type': 'application/octet-stream',
                    'Content-Range': start + '-' + end + '/' + fstats.size,
                    'Content-Length': (end - start) + 1,
                    'Connection': 'keep-alive'
                };
                this.getToken(targetHost)
                    .then((JSONToken) => {
                        const token = JSON.parse(JSONToken);
                        if (targetHost == 'localhost') {
                            headers.Authorization = localauth;
                        } else {
                            postOptions.path = `/mgmt/tm/asm/file-transfer/uploads/${policyFile}?${token.queryParam}`;
                        }
                        postOptions.headers = headers;
                        this.logger.info('uploading ' + policyFile + ' to ' + targetHost + ':' + targetPort + ' ' + start + '-' + end + '/' + fstats.size);
                        const req = httplib.request(postOptions, (res) => {
                            if (res.statusCode > 399) {
                                const err = new Error('upload part start: ' + start + ' end:' + end + ' return status: ' + res.statusCode);
                                reject(err);
                            }
                            if (end === fstats.size - 1) {
                                resolve(true);
                            } else {
                                const nextStart = start + CHUNK_SIZE;
                                const nextEnd = (() => {
                                    if (end + CHUNK_SIZE > fstats.size - 1)
                                        return fstats.size - 1;
                                    return end + CHUNK_SIZE;
                                })();
                                uploadPart(nextStart, nextEnd);
                            }
                        });
                        req.on('error', (err) => {
                            reject(err);
                        });
                        const fstream = fs.createReadStream(filePath, {
                            start: start,
                            end: end
                        });
                        fstream.on('end', () => {
                            req.end();
                        });
                        fstream.pipe(req);
                    })
                    .catch((err) => {
                        reject(err);
                    });
            };
            setImmediate(() => {
                this.logger.info('uploading policy file ' + policyFile + ' to ' + targetHost + ':' + targetPort);
                if (CHUNK_SIZE < fstats.size)
                    uploadPart(0, CHUNK_SIZE - 1);
                else
                    uploadPart(0, fstats.size - 1);
            });
        });
    }

    getToken(targetHost) {
        return new Promise((resolve) => {
            if (targetHost == 'localhost') {
                resolve(null);
            } else {
                const tokenBody = JSON.stringify({
                    address: targetHost
                });
                let body = '';
                const postOptions = {
                    host: 'localhost',
                    port: 8100,
                    path: '/shared/token',
                    headers: {
                        'Authorization': localauth,
                        'Content-Type': 'application/json',
                        'Content-Legth': tokenBody.length
                    },
                    method: 'POST'
                };
                const request = http.request(postOptions, (res) => {
                    res.on('data', (seg) => {
                        body += seg;
                    });
                    res.on('end', () => {
                        resolve(body);
                    });
                    res.on('error', (err) => {
                        this.logger.severe('error: ' + err);
                        resolve(null);
                    });
                });
                request.write(tokenBody);
                request.end();
            }
        });
    }
}

const wait = (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
});

const copyFile = (filePath, symlink) => {
    const filename = path.basename(filePath);
    const dest = downloadDirectory + '/' + filename;
    if (fs.existsSync(filePath)) {
        try {
            if (!fs.existsSync(dest)) {
                if (symlink) {
                    fs.symlinkSync(filePath, dest);
                } else {
                    fs.createReadStream(filePath).pipe(fs.createWriteStream(dest));
                }
            }
            return filename;
        } catch (err) {
            throw err;
        }
    } else {
        const err = 'file does not exist ' + filePath;
        console.error(err);
        throw Error(err);
    }
};

module.exports = TrustedASMPoliciesWorker;